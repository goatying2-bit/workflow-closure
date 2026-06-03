import { createWorkflowEngine } from '../core/workflow-engine.js';
import { resolveCheckpointSink } from '../core/checkpoint-sink.js';
import { resolveRuleProvider } from '../core/rule-provider.js';
import { createAgentAdapter } from './agent-adapter.js';
import {
  createCompositeVerifier,
  createTaskBoundaryVerifier
} from './verifier.js';
import {
  resolveAgentMemorySystem,
  resolveMemoryIntegrationContext,
  upsertMemoryBySource,
  createWorkflowTaskSourceRef,
  createWorkflowAssignmentSourceRef
} from './memory-system.js';
import {
  resolveAgentContextSystem,
  resolveContextIntegrationContext,
  upsertContextItemBySource
} from './context-system.js';
import { buildTaskPrompt } from './prompt-builder.js';
import {
  buildContextHygieneSummary,
  buildHygieneMetadata,
  classifyContextItemForPrompt,
  classifyMemoryForContext,
  classifyTaskOutputForContext,
  shouldWriteLifecycleMemory
} from './context-hygiene.js';
import {
  getPersistentAdapterPayload,
  sanitizeAdapterPayloadForPersistence,
  sanitizeExecutionErrorForPersistence,
  sanitizeRecoveryForPersistence
} from './pollution-gateway.js';
import {
  buildTaskOutputSpecs,
  mergeTaskHandoff,
  normalizeStructuredHandoff,
  resolveResultHandoff
} from './task-capture.js';
import {
  FAILURE_TYPES,
  classifyExecutionFailure,
  classifyTimeoutFailure,
  classifyVerifierFailure,
  normalizeRetryPolicy
} from './retry-policy.js';
import { normalizeWorkspacePath } from '../storage/db.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_SWEEP_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
const DEFAULT_CONTEXT_PREDECESSOR_LIMIT = 1;
const DEFAULT_CONTEXT_PREDECESSOR_OUTPUT_LIMIT = 3;
const DEFAULT_TASK_CONTEXT_QUERY_LIMIT = 4;
const DEFAULT_MAX_TASK_RETRIES = 1;
const DEFAULT_TASK_EXECUTION_TIMEOUT_MS = 0;
const DEFAULT_TIMEOUT_SWEEP_MAX_EXECUTION_MS = 0;
const DEFAULT_TIMEOUT_SWEEP_STALLED_MS = 0;
const DEFAULT_TIMEOUT_SWEEP_MAX_ATTEMPTS = null;
const DEFAULT_TIMEOUT_SWEEP_REASON = 'Task exceeded execution policy.';
const WORKFLOW_TASK_SOURCE_KIND = 'workflow-task';
const WORKFLOW_TASK_RERUN_SOURCE_KIND = 'workflow-task-rerun';
const WORKFLOW_TASK_CONTEXT_KIND = 'workflow-task-lifecycle';
const WORKFLOW_TASK_SNAPSHOT_KIND = 'workflow-task-snapshot';
const WORKFLOW_ASSIGNMENT_SOURCE_KIND = 'workflow-assignment';
const WORKFLOW_ASSIGNMENT_CONTEXT_KIND = 'workflow-assignment-lifecycle';
const DEFAULT_WORKFLOW_CLOSURE_POLICY = Object.freeze({
  closureMode: 'small_loop',
  verificationLevel: 'targeted',
  docPolicy: 'minimal',
  cleanupPolicy: 'defer'
});

export async function createWorkflowRunner(options = {}) {
  const engine = options.engine || await createWorkflowEngine(options);
  const adapter = resolveAdapter(options.adapter);
  const verifier = createCompositeVerifier([
    {
      name: 'task-boundary',
      verifier: createTaskBoundaryVerifier()
    },
    {
      name: 'custom',
      verifier: options.verifier
    }
  ]);
  const checkpointSink = resolveCheckpointSink(options.checkpointSink);
  const ruleProvider = resolveRuleProvider(options.ruleProvider);
  const memorySystem = await resolveAgentMemorySystem(options);
  const memoryContext = resolveMemoryIntegrationContext(options);
  const contextSystem = await resolveAgentContextSystem(options);
  const contextContext = resolveContextIntegrationContext(options);
  const runnerId = normalizeRunnerId(options.runnerId);
  const workflowId = normalizeOptionalText(options.workflowId);
  const taskId = normalizeOptionalText(options.taskId);
  const ownerAgentId = normalizeOptionalText(options.ownerAgentId);
  const preferredRole = normalizeOptionalText(options.preferredRole);
  const assignmentStatus = normalizeOptionalText(options.assignmentStatus);
  const baseAgentIdentity = normalizeAgentIdentity(options.agentIdentity);
  const pollIntervalMs = normalizePositiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'Poll interval');
  const leaseMs = normalizePositiveInteger(options.leaseMs, DEFAULT_LEASE_MS, 'Lease duration');
  const maxTaskRetries = normalizeNonNegativeInteger(options.maxTaskRetries, DEFAULT_MAX_TASK_RETRIES, 'Max task retries');
  const taskExecutionTimeoutMs = normalizeNonNegativeInteger(options.taskExecutionTimeoutMs, DEFAULT_TASK_EXECUTION_TIMEOUT_MS, 'Task execution timeout');
  const timeoutSweepMaxExecutionMs = normalizeNonNegativeInteger(options.timeoutSweepMaxExecutionMs, DEFAULT_TIMEOUT_SWEEP_MAX_EXECUTION_MS, 'Timeout sweep max execution');
  const timeoutSweepStalledMs = normalizeNonNegativeInteger(options.timeoutSweepStalledMs, DEFAULT_TIMEOUT_SWEEP_STALLED_MS, 'Timeout sweep stalled');
  const timeoutSweepMaxAttempts = normalizeOptionalNonNegativeInteger(options.timeoutSweepMaxAttempts, DEFAULT_TIMEOUT_SWEEP_MAX_ATTEMPTS, 'Timeout sweep max attempts');
  const timeoutSweepIntervalMs = normalizeNonNegativeInteger(options.timeoutSweepIntervalMs, DEFAULT_TIMEOUT_SWEEP_INTERVAL_MS, 'Timeout sweep interval');
  const timeoutSweepReason = normalizeOptionalText(options.timeoutSweepReason) || DEFAULT_TIMEOUT_SWEEP_REASON;
  const retryPolicy = normalizeRetryPolicy({
    ...normalizeObjectOption(options.retryPolicy, 'Retry policy'),
    maxTaskRetries
  });

  let timer = null;
  let running = false;
  let currentLoop = Promise.resolve();
  let lastTimeoutSweepAt = 0;

  return {
    runnerId,
    workflowId,
    taskId,
    ownerAgentId,
    preferredRole,
    assignmentStatus,
    pollIntervalMs,
    leaseMs,
    maxTaskRetries,
    taskExecutionTimeoutMs,
    timeoutSweepMaxExecutionMs,
    timeoutSweepStalledMs,
    timeoutSweepMaxAttempts,
    timeoutSweepIntervalMs,
    timeoutSweepReason,
    retryPolicy,
    async runOnce() {
      return runOnce({
        engine,
        adapter,
        verifier,
        checkpointSink,
        ruleProvider,
        memorySystem,
        memoryContext,
        contextSystem,
        contextContext,
        runnerId,
        workflowId,
        taskId,
        ownerAgentId,
        preferredRole,
        assignmentStatus,
        baseAgentIdentity,
        leaseMs,
        maxTaskRetries,
        taskExecutionTimeoutMs,
        timeoutSweepMaxExecutionMs,
        timeoutSweepStalledMs,
        timeoutSweepMaxAttempts,
        timeoutSweepIntervalMs,
        timeoutSweepReason,
        retryPolicy,
        updateLastTimeoutSweepAt(value) {
          lastTimeoutSweepAt = value;
        },
        getLastTimeoutSweepAt() {
          return lastTimeoutSweepAt;
        }
      });
    },
    start() {
      if (running) {
        return false;
      }

      running = true;
      scheduleNextLoop(0);
      return true;
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return currentLoop;
    },
    isRunning() {
      return running;
    }
  };

  function scheduleNextLoop(delayMs) {
    if (!running) {
      return;
    }

    timer = setTimeout(() => {
      currentLoop = runOnce({
        engine,
        adapter,
        verifier,
        checkpointSink,
        ruleProvider,
        memorySystem,
        memoryContext,
        contextSystem,
        contextContext,
        runnerId,
        workflowId,
        taskId,
        ownerAgentId,
        preferredRole,
        assignmentStatus,
        baseAgentIdentity,
        leaseMs,
        maxTaskRetries,
        taskExecutionTimeoutMs,
        timeoutSweepMaxExecutionMs,
        timeoutSweepStalledMs,
        timeoutSweepMaxAttempts,
        timeoutSweepIntervalMs,
        timeoutSweepReason,
        retryPolicy,
        updateLastTimeoutSweepAt(value) {
          lastTimeoutSweepAt = value;
        },
        getLastTimeoutSweepAt() {
          return lastTimeoutSweepAt;
        }
      })
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[workflow-runner] Loop error: ${errorMessage}`);
        })
        .finally(() => {
          timer = null;
          scheduleNextLoop(pollIntervalMs);
        });
    }, delayMs);
  }
}

async function runOnce({ engine, adapter, verifier, checkpointSink, ruleProvider, memorySystem, memoryContext, contextSystem, contextContext, runnerId, workflowId, taskId, ownerAgentId, preferredRole, assignmentStatus, baseAgentIdentity, leaseMs, taskExecutionTimeoutMs, timeoutSweepMaxExecutionMs, timeoutSweepStalledMs, timeoutSweepMaxAttempts, timeoutSweepIntervalMs, timeoutSweepReason, retryPolicy, updateLastTimeoutSweepAt, getLastTimeoutSweepAt }) {
  const maintenance = await runMaintenance({
    engine,
    workflowId,
    timeoutSweepMaxExecutionMs,
    timeoutSweepStalledMs,
    timeoutSweepMaxAttempts,
    timeoutSweepIntervalMs,
    timeoutSweepReason,
    updateLastTimeoutSweepAt,
    getLastTimeoutSweepAt
  });
  const { released, swept } = maintenance;
  const releasedTaskCount = released.releasedTaskCount;
  const sweptReleasedTaskCount = swept.releasedTaskCount;
  const sweptBlockedTaskCount = swept.blockedTaskCount;
  const claimed = await engine.claimNextReadyTask({
    workflowId,
    taskId,
    leaseOwner: runnerId,
    leaseMs,
    ownerAgentId,
    preferredRole,
    assignmentStatus,
    skipExpiredLeaseSweep: true
  });

  if (!claimed) {
    return {
      status: 'idle',
      runnerId,
      releasedTaskCount,
      sweptReleasedTaskCount,
      sweptBlockedTaskCount,
      task: null,
      workflow: null,
      activeMemoryContext: null,
      executionContext: null,
      contextSnapshot: null,
      contextItems: [],
      recalledMemories: []
    };
  }

  const { task } = claimed;
  const effectiveTimeoutPolicy = resolveTaskTimeoutPolicy(task, {
    executionTimeoutMs: taskExecutionTimeoutMs,
    stalledTimeoutMs: timeoutSweepStalledMs,
    maxAttempts: timeoutSweepMaxAttempts,
    timeoutReason: timeoutSweepReason
  });
  const state = engine.getWorkflowState({ workflowId: task.workflowId });
  const workflowClosurePolicy = resolveWorkflowClosurePolicy(state.workflow?.initialPlan?.metadata);
  const agentIdentity = resolveAgentIdentity(task, runnerId, baseAgentIdentity);
  const assignment = buildTaskAssignment(task);
  const handoffContext = buildTaskHandoffContext(state, task);
  const predecessorOutputs = engine.listPredecessorTaskOutputs(buildPredecessorOutputQuery(task));
  const effectiveMemoryContext = resolveEffectiveMemoryContext(memoryContext, agentIdentity);
  const recalled = await recallTaskMemories(memorySystem, effectiveMemoryContext, state, task, assignment, handoffContext);
  const activeMemoryContext = buildActiveMemoryContext(effectiveMemoryContext, recalled);
  const executionContext = buildExecutionContext({
    agentIdentity,
    activeMemoryContext,
    contextContext
  });
  const contextBundle = buildTaskContextBundle({
    contextSystem,
    contextContext,
    state,
    task,
    recalled,
    agentIdentity,
    assignment,
    handoffContext,
    predecessorOutputs,
    executionContext
  });
  const contextSnapshot = writeTaskContextSnapshot(contextSystem, contextContext, state.workflow, task, contextBundle);

  let prompt = null;
  let ruleContext = { rules: [], metadata: {} };
  let heartbeatInterval = null;

  try {
    ruleContext = await ruleProvider.getRules({
      workflow: state.workflow,
      task,
      tasks: state.tasks,
      dependencies: state.dependencies,
      runLogs: state.runLogs || [],
      runnerId,
      contextSnapshot,
      contextItems: contextBundle.items,
      memoryContext: recalled,
      agentIdentity,
      assignment,
      handoffContext,
      executionContext
    });

    prompt = buildTaskPrompt(state, task, {
      workflowClosurePolicy,
      memoryContext: recalled,
      contextSnapshot,
      contextItems: contextBundle.items,
      agentIdentity,
      assignment,
      handoffContext,
      predecessorOutputs,
      ruleContext,
      executionContext
    });

    heartbeatInterval = setInterval(() => {
      Promise.resolve()
        .then(() => engine.heartbeatTaskLease({
          workflowId: task.workflowId,
          taskId: task.taskId,
          leaseOwner: runnerId,
          leaseMs
        }))
        .catch((heartbeatError) => {
          console.error(`[workflow-runner] Heartbeat failed for task ${task.taskId}: ${heartbeatError.message}`);
        });
    }, DEFAULT_HEARTBEAT_INTERVAL_MS);

    const result = await runWithExecutionTimeout(adapter.run({
      workflow: state.workflow,
      task,
      tasks: state.tasks,
      dependencies: state.dependencies,
      runLogs: state.runLogs || [],
      prompt,
      runnerId,
      leaseMs,
      memoryContext: recalled,
      recalledMemories: recalled.items,
      activeMemoryContext,
      executionContext,
      contextSnapshot,
      contextItems: contextBundle.items,
      ruleContext,
      agentIdentity,
      assignment,
      handoffContext
    }), {
      timeoutMs: effectiveTimeoutPolicy.executionTimeoutMs,
      workflowId: task.workflowId,
      taskId: task.taskId,
      attemptCount: task.attemptCount
    });

    let verification = null;
    let verificationFailure = null;
    let finalizedResult = result;

    if (result.status === 'done') {
      verification = await verifier.run({
        workflow: state.workflow,
        workflowClosurePolicy,
        task,
        result,
        state,
        runnerId,
        prompt,
        assignment,
        handoffContext,
        memoryContext: recalled,
        contextSnapshot,
        contextItems: contextBundle.items,
        ruleContext,
        agentIdentity
      });

      if (verification.status === 'failed') {
        verificationFailure = classifyVerifierFailure({
          task,
          verifierResult: verification,
          policy: retryPolicy
        });
        finalizedResult = {
          ...result,
          status: verificationFailure.nextStatus,
          doneSummary: null,
          blockedReason: verificationFailure.nextStatus === 'blocked'
            ? verificationFailure.error
            : null,
          message: verification.message || verificationFailure.message || result.message,
          payload: result.payload ?? null
        };
      }
    }

    const persistentResultPayload = sanitizeAdapterPayloadForPersistence(result.payload ?? null, {
      status: finalizedResult.status,
      reasonCode: verification?.reasonCode || verificationFailure?.recovery?.reasonCode || null,
      recovery: verificationFailure?.recovery || null
    });
    const persistentResult = {
      ...finalizedResult,
      payload: persistentResultPayload
    };
    const nextHandoff = mergeTaskHandoff(task.handoff, resolveResultHandoff(persistentResult), task, persistentResult);

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    const checkpoint = await writeCheckpointResult(checkpointSink, {
      workflow: state.workflow,
      task,
      tasks: state.tasks,
      dependencies: state.dependencies,
      runLogs: state.runLogs || [],
      result: persistentResult,
      prompt,
      runnerId,
      verification,
      contextSnapshot,
      contextItems: contextBundle.items,
      ruleContext,
      agentIdentity,
      assignment,
      handoff: nextHandoff
    });

    const validationTaskOutputs = buildValidationVerifierTaskOutputs(verification, {
      runnerId,
      workspacePath: contextContext.workspacePath,
      workflowClosurePolicy
    });
    const taskOutputs = [
      ...validationTaskOutputs,
      ...buildTaskOutputSpecs(persistentResult, {
        runnerId,
        nextHandoff,
        verification,
        checkpoint,
        workspacePath: contextContext.workspacePath,
        workflowClosurePolicy
      })
    ];

    let advanced;

    try {
      advanced = engine.advanceTaskStatus({
        workflowId: task.workflowId,
        taskId: task.taskId,
        status: persistentResult.status,
        doneSummary: persistentResult.doneSummary,
        blockedReason: persistentResult.blockedReason,
        lastError: persistentResult.status === 'blocked' ? persistentResult.blockedReason : null,
        reasonCode: verification?.reasonCode || verificationFailure?.recovery?.reasonCode || null,
        recovery: verificationFailure?.recovery || null,
        expectedLeaseOwner: runnerId,
        action: persistentResult.status === 'done' ? 'task_completed_by_runner' : 'task_blocked_by_runner',
        message: persistentResult.message || defaultStatusMessage(task.title, persistentResult.status),
        handoff: nextHandoff,
        taskOutputs,
        payload: {
          runnerId,
          workflowClosurePolicy,
          prompt,
          contextSnapshotId: contextSnapshot?.snapshotId || null,
          contextItemCount: contextBundle.items.length,
          ruleCount: ruleContext.rules.length,
          ruleMetadata: ruleContext.metadata,
          assignment,
          handoff: nextHandoff,
          adapterPayload: persistentResultPayload,
          verification,
          recovery: verificationFailure?.recovery || null,
          checkpoint,
          taskOutputs
        }
      });
    } catch (finalizeError) {
      if (isLeaseLostBeforeFinalizeError(finalizeError)) {
        engine.addRunLog({
          workflowId: task.workflowId,
          taskId: task.taskId,
          action: 'task_finalize_skipped_lease_lost',
          message: `Runner skipped finalize for task "${task.title}" after losing lease ownership.`,
          payload: {
            runnerId,
            taskId: task.taskId,
            attemptedStatus: finalizedResult.status,
            verification,
            checkpoint,
            error: finalizeError.message,
            reasonCode: 'lease_lost_before_finalize'
          }
        });

        const refreshed = engine.getWorkflowState({ workflowId: task.workflowId });
        const refreshedTask = refreshed.tasks.find((item) => item.taskId === task.taskId) || task;

        return {
          status: 'idle',
          runnerId,
          releasedTaskCount,
          sweptReleasedTaskCount,
          sweptBlockedTaskCount,
          task: refreshedTask,
          workflow: refreshed.workflow,
          nextTask: refreshed.nextTask,
          prompt,
          memoryContext: recalled,
          activeMemoryContext,
          executionContext,
          recalledMemories: recalled.items,
          contextSnapshot,
          contextItems: contextBundle.items,
          ruleContext,
          agentIdentity,
          assignment,
          handoff: nextHandoff,
          adapterPayload: persistentResultPayload,
          verification,
          checkpoint,
          reasonCode: 'lease_lost_before_finalize'
        };
      }

      throw finalizeError;
    }
    await writeTaskLifecycleMemory(memorySystem, memoryContext, state.workflow, advanced.task, {
      prompt,
      result: persistentResult,
      runnerId,
      kind: persistentResult.status === 'done' ? 'done' : 'blocked',
      verification,
      contextSnapshot,
      contextItems: contextBundle.items,
      agentIdentity,
      assignment,
      handoff: nextHandoff
    });
    await writeTaskLifecycleContext(contextSystem, contextContext, state.workflow, advanced.task, {
      prompt,
      result: persistentResult,
      runnerId,
      kind: persistentResult.status === 'done' ? 'done' : 'blocked',
      contextSnapshot,
      contextItems: contextBundle.items,
      ruleContext,
      agentIdentity,
      assignment,
      handoff: nextHandoff
    });
    await writeAssignmentLifecycleMemory(memorySystem, memoryContext, state.workflow, advanced.task, {
      runnerId,
      assignment,
      kind: persistentResult.status,
      verification,
      handoff: nextHandoff
    });
    await writeAssignmentLifecycleContext(contextSystem, contextContext, state.workflow, advanced.task, {
      runnerId,
      assignment,
      kind: persistentResult.status,
      handoff: nextHandoff
    });

    return {
      status: persistentResult.status,
      runnerId,
      releasedTaskCount,
      sweptReleasedTaskCount,
      sweptBlockedTaskCount,
      task: advanced.task,
      workflow: advanced.workflow,
      nextTask: advanced.nextTask,
      prompt,
      memoryContext: recalled,
      activeMemoryContext,
      executionContext,
      recalledMemories: recalled.items,
      contextSnapshot,
      contextItems: contextBundle.items,
      ruleContext,
      agentIdentity,
      assignment,
      handoff: nextHandoff,
      adapterPayload: persistentResultPayload,
      verification,
      checkpoint
    };
  } catch (error) {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    const classifiedFailure = classifyTaskExecutionFailure({
      error,
      task,
      retryPolicy,
      timeoutPolicy: effectiveTimeoutPolicy
    });
    const adapterPayload = sanitizeAdapterPayloadForPersistence(normalizeErrorAdapterPayload(error), {
      error,
      classifiedFailure
    });
    const sanitizedError = sanitizeExecutionErrorForPersistence(error, {
      classifiedFailure,
      adapterPayload
    });
    const sanitizedRecovery = sanitizeRecoveryForPersistence(classifiedFailure.recovery, {
      error: sanitizedError,
      adapterPayload
    });
    const nextHandoff = mergeTaskHandoff(task.handoff, null, task, {
      status: classifiedFailure.nextStatus,
      blockedReason: sanitizedError,
      payload: null
    });
    const checkpoint = await writeCheckpointResult(checkpointSink, {
      workflow: state.workflow,
      task,
      tasks: state.tasks,
      dependencies: state.dependencies,
      runLogs: state.runLogs || [],
      result: {
        status: classifiedFailure.nextStatus,
        doneSummary: null,
        blockedReason: sanitizedError,
        payload: null,
        handoff: nextHandoff,
        message: classifiedFailure.message
      },
      prompt,
      runnerId,
      verification: null,
      contextSnapshot,
      contextItems: contextBundle.items,
      ruleContext,
      agentIdentity,
      assignment,
      handoff: nextHandoff,
      error: sanitizedError,
      adapterPayload,
      recovery: sanitizedRecovery
    });
    const taskOutputs = buildTaskOutputSpecs({
      status: classifiedFailure.nextStatus,
      doneSummary: null,
      blockedReason: sanitizedError,
      message: classifiedFailure.message,
      payload: null
    }, {
      runnerId,
      nextHandoff,
      verification: null,
      checkpoint,
      workspacePath: contextContext.workspacePath,
      workflowClosurePolicy
    });

    let advanced;

    try {
      advanced = engine.advanceTaskStatus({
        workflowId: task.workflowId,
        taskId: task.taskId,
        status: classifiedFailure.nextStatus,
        blockedReason: classifiedFailure.nextStatus === 'blocked' ? sanitizedError : null,
        lastError: sanitizedError,
        reasonCode: sanitizedRecovery.reasonCode,
        recovery: sanitizedRecovery,
        expectedLeaseOwner: runnerId,
        action: classifiedFailure.action,
        message: classifiedFailure.message,
        handoff: nextHandoff,
        taskOutputs,
        payload: {
          runnerId,
          workflowClosurePolicy,
          prompt,
          contextSnapshotId: contextSnapshot?.snapshotId || null,
          contextItemCount: contextBundle.items.length,
          ruleCount: ruleContext.rules.length,
          ruleMetadata: ruleContext.metadata,
          assignment,
          handoff: nextHandoff,
          error: sanitizedError,
          recovery: sanitizedRecovery,
          adapterPayload,
          checkpoint,
          taskOutputs
        }
      });
    } catch (finalizeError) {
      if (isLeaseLostBeforeFinalizeError(finalizeError)) {
        engine.addRunLog({
          workflowId: task.workflowId,
          taskId: task.taskId,
          action: 'task_finalize_skipped_lease_lost',
          message: `Runner skipped finalize for task "${task.title}" after losing lease ownership.`,
          payload: {
            runnerId,
            taskId: task.taskId,
            attemptedStatus: classifiedFailure.nextStatus,
            checkpoint,
            error: finalizeError.message,
            reasonCode: 'lease_lost_before_finalize'
          }
        });

        const refreshed = engine.getWorkflowState({ workflowId: task.workflowId });
        const refreshedTask = refreshed.tasks.find((item) => item.taskId === task.taskId) || task;

        return {
          status: 'idle',
          runnerId,
          releasedTaskCount,
          sweptReleasedTaskCount,
          sweptBlockedTaskCount,
          task: refreshedTask,
          workflow: refreshed.workflow,
          nextTask: refreshed.nextTask,
          prompt,
          memoryContext: recalled,
          activeMemoryContext,
          executionContext,
          recalledMemories: recalled.items,
          contextSnapshot,
          contextItems: contextBundle.items,
          ruleContext,
          agentIdentity,
          assignment,
          handoff: nextHandoff,
          error: sanitizedError,
          adapterPayload,
          recovery: sanitizedRecovery,
          checkpoint,
          reasonCode: 'lease_lost_before_finalize'
        };
      }

      throw finalizeError;
    }

    await writeTaskLifecycleMemory(memorySystem, memoryContext, state.workflow, advanced.task, {
      prompt,
      runnerId,
      kind: 'error',
      error: sanitizedError,
      contextSnapshot,
      contextItems: contextBundle.items,
      agentIdentity,
      assignment,
      handoff: nextHandoff
    });
    await writeTaskLifecycleContext(contextSystem, contextContext, state.workflow, advanced.task, {
      prompt,
      runnerId,
      kind: 'error',
      error: sanitizedError,
      contextSnapshot,
      contextItems: contextBundle.items,
      ruleContext,
      agentIdentity,
      assignment,
      handoff: nextHandoff
    });
    await writeAssignmentLifecycleMemory(memorySystem, memoryContext, state.workflow, advanced.task, {
      runnerId,
      assignment,
      kind: 'error',
      handoff: nextHandoff,
      error: sanitizedError
    });
    await writeAssignmentLifecycleContext(contextSystem, contextContext, state.workflow, advanced.task, {
      runnerId,
      assignment,
      kind: 'error',
      handoff: nextHandoff,
      error: sanitizedError
    });

    return {
      status: classifiedFailure.nextStatus,
      runnerId,
      releasedTaskCount,
      sweptReleasedTaskCount,
      sweptBlockedTaskCount,
      task: advanced.task,
      workflow: advanced.workflow,
      nextTask: advanced.nextTask,
      prompt,
      memoryContext: recalled,
      activeMemoryContext,
      executionContext,
      recalledMemories: recalled.items,
      contextSnapshot,
      contextItems: contextBundle.items,
      ruleContext,
      agentIdentity,
      assignment,
      handoff: nextHandoff,
      error: sanitizedError,
      adapterPayload,
      recovery: sanitizedRecovery,
      checkpoint
    };
  }
}

function buildPredecessorOutputQuery(task) {
  const query = {
    workflowId: task.workflowId,
    taskId: task.taskId,
    trustStates: ['validated'],
    includeFilterSummary: true,
    limitPerTask: DEFAULT_CONTEXT_PREDECESSOR_OUTPUT_LIMIT
  };

  if (isValidationRepairTask(task)) {
    query.kind = 'validation-result';
    query.name = 'validation-commands';
    query.trustStates = ['failed'];
    query.includeUnverified = false;
  }

  return query;
}

function isValidationRepairTask(task) {
  return task?.planTaskKey === 'repair-validation-failure'
    || task?.contract?.repairOf === 'validation-result';
}

function summarizeWorkflowClosurePolicy(policy) {
  const resolved = resolveWorkflowClosurePolicy(policy);
  return {
    closureMode: resolved.closureMode,
    verificationLevel: resolved.verificationLevel,
    docPolicy: resolved.docPolicy,
    cleanupPolicy: resolved.cleanupPolicy
  };
}

function resolveWorkflowClosurePolicy(metadata) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : null;

  return {
    closureMode: normalizeWorkflowClosureMode(source?.closureMode),
    verificationLevel: normalizeWorkflowVerificationLevel(source?.verificationLevel),
    docPolicy: normalizeWorkflowDocPolicy(source?.docPolicy),
    cleanupPolicy: normalizeWorkflowCleanupPolicy(source?.cleanupPolicy)
  };
}

function normalizeWorkflowClosureMode(value) {
  return value === 'large_loop' ? 'large_loop' : DEFAULT_WORKFLOW_CLOSURE_POLICY.closureMode;
}

function normalizeWorkflowVerificationLevel(value) {
  return value === 'broad' ? 'broad' : DEFAULT_WORKFLOW_CLOSURE_POLICY.verificationLevel;
}

function normalizeWorkflowDocPolicy(value) {
  return value === 'required' ? 'required' : DEFAULT_WORKFLOW_CLOSURE_POLICY.docPolicy;
}

function normalizeWorkflowCleanupPolicy(value) {
  return value === 'explicit_only' ? 'explicit_only' : DEFAULT_WORKFLOW_CLOSURE_POLICY.cleanupPolicy;
}

function buildValidationVerifierTaskOutputs(verification, context = {}) {
  const validationResult = findValidationVerifierResult(verification);
  if (!validationResult) {
    return [];
  }

  return [{
    kind: 'validation-result',
    name: 'validation-commands',
    content: summarizeValidationCommandResults(validationResult),
    workspacePath: context.workspacePath,
    metadata: {
      runnerId: context.runnerId || null,
      workflowClosurePolicy: summarizeWorkflowClosurePolicy(context.workflowClosurePolicy),
      status: validationResult.status,
      reason: validationResult.reason || null,
      reasonCode: validationResult.reasonCode || null,
      validationResults: validationResult.payload?.results || [],
      failedCommand: validationResult.payload?.failedCommand || null
    }
  }];
}

function findValidationVerifierResult(verification) {
  if (verification?.payload?.verifier === 'validation-commands') {
    return verification;
  }

  const compositeResults = verification?.payload?.results;
  if (!Array.isArray(compositeResults)) {
    return null;
  }

  return compositeResults.find((result) => result?.payload?.verifier === 'validation-commands') || null;
}

function summarizeValidationCommandResults(validationResult) {
  const results = Array.isArray(validationResult?.payload?.results)
    ? validationResult.payload.results
    : [];
  const failedCount = results.filter((result) => result.required && (result.exitCode !== 0 || result.timedOut)).length;
  const status = validationResult?.status === 'passed' ? 'passed' : 'failed';
  return JSON.stringify({
    status,
    commandCount: results.length,
    failedCount
  });
}

async function writeCheckpointResult(checkpointSink, input) {
  try {
    return await checkpointSink.write(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      summary: `Checkpoint sink threw while handling task "${input?.task?.title || 'unknown-task'}".`,
      artifactRef: null,
      metadata: {
        checkpointSink: 'runtime-error'
      },
      payload: {
        error: message
      }
    };
  }
}

async function recallTaskMemories(memorySystem, memoryContext, state, task, assignment, handoffContext) {
  if (!memorySystem || !memoryContext.enabled) {
    return {
      items: [],
      total: 0,
      query: null,
      exactItems: [],
      structuralItems: [],
      graphItems: [],
      semanticItems: []
    };
  }

  const exactItems = filterRecalledMemoryItems(
    await recallExactTaskMemories(memorySystem, memoryContext, state, task),
    memoryContext
  );
  const structuralItems = filterRecalledMemoryItems(
    await recallStructuredTaskMemories(memorySystem, memoryContext, state, task),
    memoryContext
  ).filter((item) => !exactItems.some((exactItem) => exactItem.memoryId === item.memoryId));
  const graphItems = filterRecalledMemoryItems(
    await recallGraphTaskMemories(memorySystem, memoryContext, state, task),
    memoryContext
  ).filter((item) => !exactItems.some((exactItem) => exactItem.memoryId === item.memoryId)
    && !structuralItems.some((structuralItem) => structuralItem.memoryId === item.memoryId));

  const seedItems = dedupeMemoryItemsById([...exactItems, ...structuralItems, ...graphItems]);
  const semanticText = buildTaskRecallText(state, task, assignment, handoffContext);
  const semanticLaneLimit = resolveTaskSemanticLaneLimit({
    limit: memoryContext.limit,
    enabled: Boolean(semanticText)
  });
  const semanticQueryLimit = Math.max(
    memoryContext.limit ?? 0,
    DEFAULT_TASK_CONTEXT_QUERY_LIMIT
  );
  const semanticCandidates = semanticLaneLimit > 0
    ? filterRecalledMemoryItems(
      await recallSemanticTaskMemories(memorySystem, memoryContext, state, task, assignment, handoffContext, semanticQueryLimit),
      memoryContext
    ).filter((item) => !seedItems.some((seedItem) => seedItem.memoryId === item.memoryId))
    : [];
  const semanticItems = memoryContext.limit == null
    ? semanticCandidates
    : semanticCandidates.slice(0, semanticLaneLimit);
  const selectedSeedItems = memoryContext.limit == null
    ? seedItems
    : seedItems.slice(0, Math.max(0, memoryContext.limit - semanticItems.length));
  const items = dedupeMemoryItemsById([...selectedSeedItems, ...semanticItems]).slice(0, memoryContext.limit);

  return {
    items,
    total: items.length,
    exactItems,
    structuralItems,
    graphItems,
    semanticItems,
    query: {
      workflowId: state.workflow?.workflowId || null,
      taskId: task.taskId,
      exactSourceRef: createWorkflowTaskSourceRef(task.workflowId, task.taskId),
      structural: {
        workflowId: task.workflowId,
        taskId: task.taskId
      },
      graph: seedItems.length > 0,
      semanticReservedSlots: semanticLaneLimit,
      semanticText: semanticItems.length > 0 ? semanticText : null
    }
  };
}


async function recallExactTaskMemories(memorySystem, memoryContext, state, task) {
  const sourceRef = createWorkflowTaskSourceRef(task.workflowId, task.taskId);
  const recalled = await memorySystem.recall({
    scope: memoryContext.scope,
    projectKey: memoryContext.projectKey || undefined,
    workspacePath: memoryContext.workspacePath || undefined,
    sessionId: memoryContext.sessionId || undefined,
    sourceRef,
    graph: false,
    limit: memoryContext.limit
  });

  return Array.isArray(recalled?.items)
    ? recalled.items.map((item) => ({
        ...item,
        matchedBy: {
          ...(normalizeMemoryMatchMetadata(item.matchedBy) || {}),
          exactSourceRef: true
        },
        authority: item.authority || 'high'
      }))
    : [];
}

async function recallStructuredTaskMemories(memorySystem, memoryContext, state, task) {
  const taskSourceRef = createWorkflowTaskSourceRef(task.workflowId, task.taskId);
  const assignmentSourceRef = createWorkflowAssignmentSourceRef(task.workflowId, task.taskId);
  const recalled = await memorySystem.recall({
    scope: memoryContext.scope,
    projectKey: memoryContext.projectKey || undefined,
    workspacePath: memoryContext.workspacePath || undefined,
    sessionId: memoryContext.sessionId || undefined,
    workflowId: task.workflowId,
    taskId: task.taskId,
    graph: false,
    limit: Math.max(memoryContext.limit, DEFAULT_TASK_CONTEXT_QUERY_LIMIT)
  });

  return Array.isArray(recalled?.items)
    ? recalled.items
      .filter((item) => isStructuredTaskMemoryMatch(item, task, {
        taskSourceRef,
        assignmentSourceRef
      }))
      .map((item) => ({
        ...item,
        matchedBy: {
          ...(normalizeMemoryMatchMetadata(item.matchedBy) || {}),
          structural: true
        },
        authority: item.authority || 'medium'
      }))
    : [];
}

function isStructuredTaskMemoryMatch(item, task, input = {}) {
  if (!item || !task) {
    return false;
  }

  if (item.workflowId !== task.workflowId || item.taskId !== task.taskId) {
    return false;
  }

  const taskSourceRef = normalizeOptionalText(input.taskSourceRef);
  const assignmentSourceRef = normalizeOptionalText(input.assignmentSourceRef);
  const itemSourceKind = normalizeOptionalText(item.sourceKind);
  const itemSourceRef = normalizeOptionalText(item.sourceRef);
  const itemSubjectKind = normalizeOptionalText(item.subjectKind);
  const itemSubjectRef = normalizeOptionalText(item.subjectRef);
  const isAssignmentMemory = itemSourceKind === WORKFLOW_ASSIGNMENT_SOURCE_KIND || itemSubjectKind === WORKFLOW_ASSIGNMENT_SOURCE_KIND;
  const isTaskMemory = itemSourceKind === WORKFLOW_TASK_SOURCE_KIND
    || itemSubjectKind === WORKFLOW_TASK_SOURCE_KIND
    || itemSourceKind === WORKFLOW_TASK_RERUN_SOURCE_KIND
    || itemSubjectKind === WORKFLOW_TASK_RERUN_SOURCE_KIND;

  if (isAssignmentMemory) {
    return itemSourceRef === assignmentSourceRef || itemSubjectRef === assignmentSourceRef;
  }

  if (isTaskMemory) {
    return itemSourceRef === taskSourceRef || itemSubjectRef === taskSourceRef;
  }

  return false;
}

async function recallGraphTaskMemories(memorySystem, memoryContext, state, task) {
  const recalled = await memorySystem.recall({
    scope: memoryContext.scope,
    projectKey: memoryContext.projectKey || undefined,
    workspacePath: memoryContext.workspacePath || undefined,
    sessionId: memoryContext.sessionId || undefined,
    workflowId: task.workflowId,
    taskId: task.taskId,
    graph: true,
    limit: Math.max(memoryContext.limit, DEFAULT_TASK_CONTEXT_QUERY_LIMIT)
  });

  return Array.isArray(recalled?.items)
    ? recalled.items
      .filter((item) => Boolean(item?.matchedBy?.graph))
      .map((item) => ({
        ...item,
        matchedBy: {
          ...(normalizeMemoryMatchMetadata(item.matchedBy) || {}),
          graph: true
        },
        authority: item.authority || 'medium'
      }))
    : [];
}

async function recallSemanticTaskMemories(memorySystem, memoryContext, state, task, assignment, handoffContext, limit) {
  const text = buildTaskRecallText(state, task, assignment, handoffContext);
  const recalled = await memorySystem.recall({
    scope: memoryContext.scope,
    projectKey: memoryContext.projectKey || undefined,
    workspacePath: memoryContext.workspacePath || undefined,
    sessionId: memoryContext.sessionId || undefined,
    text,
    limit
  });

  return Array.isArray(recalled?.items)
    ? recalled.items.map((item) => ({
        ...item,
        matchedBy: {
          ...(normalizeMemoryMatchMetadata(item.matchedBy) || {}),
          semantic: true
        },
        authority: item.authority || 'low'
      }))
    : [];
}

function filterRecalledMemoryItems(items, memoryContext) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  return items
    .filter((item) => isMemoryItemAllowedForContext(item, memoryContext))
    .map((item) => attachMemoryHygiene(item));
}

function attachMemoryHygiene(item) {
  const classification = classifyMemoryForContext(item);
  return {
    ...item,
    hygieneLabel: classification.hygieneLabel,
    sourceClass: classification.sourceClass,
    allowedUse: classification.allowedUse,
    promptAllowed: classification.promptAllowed,
    hygiene: buildHygieneMetadata({
      classification,
      provenance: {
        sourceKind: item?.sourceKind || null,
        sourceRef: item?.sourceRef || null,
        memoryId: item?.memoryId || null
      }
    })
  };
}

function isMemoryItemAllowedForContext(item, memoryContext) {
  if (!item || item.status !== 'active') {
    return false;
  }

  if (memoryContext.scope && item.scope !== memoryContext.scope) {
    return false;
  }

  const expectedWorkspacePath = normalizeOptionalWorkspacePath(memoryContext.workspacePath);
  const itemWorkspacePath = normalizeOptionalWorkspacePath(item.workspacePath);
  if (expectedWorkspacePath && itemWorkspacePath !== expectedWorkspacePath) {
    return false;
  }

  if (memoryContext.projectKey && item.projectKey !== memoryContext.projectKey) {
    return false;
  }

  if (memoryContext.sessionId && item.sessionId !== memoryContext.sessionId) {
    return false;
  }

  return true;
}

function normalizeOptionalWorkspacePath(value) {
  return value == null ? null : normalizeWorkspacePath(value);
}

function normalizeMemoryMatchMetadata(value, fallback = null) {
  if (value == null) {
    return fallback ? { ...fallback } : null;
  }

  if (typeof value === 'string') {
    return value === 'exact-source-ref'
      ? { exactSourceRef: true }
      : { label: value };
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return { ...value };
  }

  return fallback ? { ...fallback } : { label: String(value) };
}

function buildMemorySelectionReasons(item, recalled) {
  const reasons = [];
  const memoryId = item?.memoryId;

  if (memoryId && Array.isArray(recalled?.exactItems) && recalled.exactItems.some((exactItem) => exactItem.memoryId === memoryId)) {
    reasons.push('exact-memory');
  }

  if (memoryId && Array.isArray(recalled?.structuralItems) && recalled.structuralItems.some((structuralItem) => structuralItem.memoryId === memoryId)) {
    reasons.push('structural-memory');
  }

  if (memoryId && Array.isArray(recalled?.graphItems) && recalled.graphItems.some((graphItem) => graphItem.memoryId === memoryId)) {
    reasons.push('graph-memory');
  }

  if (memoryId && Array.isArray(recalled?.semanticItems) && recalled.semanticItems.some((semanticItem) => semanticItem.memoryId === memoryId)) {
    reasons.push('semantic-memory');
  }

  if (reasons.length === 0 && item?.matchedBy?.exactSourceRef) {
    reasons.push('exact-memory');
  }

  if (reasons.length === 0 && (item?.matchedBy?.structural || item?.matchedBy?.subjectRef || item?.matchedBy?.workflowId || item?.matchedBy?.taskId || item?.matchedBy?.eventKind)) {
    reasons.push('structural-memory');
  }

  if (reasons.length === 0 && item?.matchedBy?.graph) {
    reasons.push('graph-memory');
  }

  if (reasons.length === 0 && item?.matchedBy?.semantic) {
    reasons.push('semantic-memory');
  }

  return reasons.length > 0 ? reasons : ['memory'];
}

function dedupeMemoryItemsById(items) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = createMemoryDeduplicationKey(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }

  return output;
}

function createMemoryDeduplicationKey(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  if (item.memoryId) {
    return `memory:${item.memoryId}`;
  }

  if (item.sourceKind && item.sourceRef) {
    const workspacePath = normalizeOptionalWorkspacePath(item.workspacePath) || 'global';
    const scope = item.scope || 'global';
    const projectKey = item.projectKey || 'none';
    const sessionId = item.sessionId || 'none';
    return `source:${scope}:${workspacePath}:${projectKey}:${sessionId}:${item.sourceKind}:${item.sourceRef}`;
  }

  return null;
}

function buildTaskContextBundle({ contextSystem, contextContext, state, task, recalled, agentIdentity, assignment, handoffContext, predecessorOutputs = [], executionContext = null }) {
  if (!contextSystem || !contextContext.enabled) {
    return {
      items: [],
      summary: null,
      content: null,
      metadata: null
    };
  }

  const relatedContext = queryRelatedContextItems(contextSystem, contextContext, state, task);
  const resumeHint = buildResumeHintContextItem(task, relatedContext.taskItems);
  const rerunHint = buildRerunHintContextItem(relatedContext.taskItems);
  const items = [];
  items.push(createContextBundleItem({
    kind: 'current-task',
    priority: 100,
    title: task.title,
    summary: task.description || '当前任务没有额外描述。',
    content: [
      `taskId: ${task.taskId}`,
      `title: ${task.title}`,
      `description: ${task.description || '无'}`,
      `attemptCount: ${task.attemptCount || 0}`
    ].join('\n'),
    selectedBecause: ['current-task'],
    authority: 'authoritative'
  }));

  if (agentIdentity) {
    items.push(createContextBundleItem({
      kind: 'agent-identity',
      priority: 99,
      title: agentIdentity.name || agentIdentity.agentId || '当前 agent',
      summary: agentIdentity.role || '未指定角色',
      content: [
        `agentId: ${agentIdentity.agentId || '无'}`,
        `name: ${agentIdentity.name || '无'}`,
        `role: ${agentIdentity.role || '无'}`,
        `capabilities: ${agentIdentity.capabilities.length > 0 ? agentIdentity.capabilities.join(', ') : '无'}`
      ].join('\n'),
      selectedBecause: ['agent-identity'],
      authority: 'authoritative'
    }));
  }

  if (executionContext) {
    const executionContextItems = buildExecutionContextItems(executionContext);
    items.push(...executionContextItems);
  }

  if (assignment && hasAssignmentContent(assignment)) {
    items.push(createContextBundleItem({
      kind: 'assignment',
      priority: 98,
      title: '当前分配',
      summary: assignment.assignmentReason || assignment.preferredRole || assignment.assignmentStatus || '存在任务分配信息。',
      content: formatAssignmentContent(assignment),
      selectedBecause: ['task-assignment'],
      authority: 'authoritative'
    }));
  }

  if (resumeHint) {
    items.push(resumeHint);
  }

  if (rerunHint) {
    items.push(rerunHint);
  }

  if (task.lastError) {
    items.push(createContextBundleItem({
      kind: 'last-error',
      priority: 92,
      title: '最近错误',
      summary: task.lastError,
      content: task.lastError,
      selectedBecause: ['last-error'],
      authority: 'adjacent'
    }));
  }

  if (handoffContext?.current) {
    items.push(createContextBundleItem({
      kind: 'handoff',
      priority: 94,
      title: '当前任务交接',
      summary: handoffContext.current.summary || '当前任务存在结构化交接。',
      content: formatHandoffContent(handoffContext.current),
      selectedBecause: ['current-handoff'],
      authority: 'authoritative'
    }));
  }

  if (Array.isArray(handoffContext?.predecessors)) {
    const predecessorHandoffs = handoffContext.predecessors
      .slice(0, DEFAULT_CONTEXT_PREDECESSOR_LIMIT)
      .map((item, index) => createContextBundleItem({
        kind: 'handoff',
        priority: 91 - index,
        title: `${item.title} 交接`,
        summary: item.handoff.summary || item.doneSummary || '上游任务交接。',
        content: formatHandoffContent(item.handoff, item.doneSummary),
        sourceRef: item.handoff.sourceRef || null,
        selectedBecause: ['predecessor-handoff'],
        authority: 'adjacent'
      }));
    items.push(...predecessorHandoffs);
  }

  const predecessors = getCompletedPredecessors(state, task)
    .slice(0, DEFAULT_CONTEXT_PREDECESSOR_LIMIT)
    .map((item, index) => createContextBundleItem({
      kind: 'predecessor-summary',
      priority: 88 - index,
      title: item.title,
      summary: item.doneSummary || '无完成摘要。',
      content: item.doneSummary || '无完成摘要。',
      sourceRef: item.taskId || null,
      selectedBecause: ['predecessor-summary'],
      authority: 'adjacent'
    }));
  items.push(...predecessors);

  const predecessorOutputItems = Array.isArray(predecessorOutputs)
    ? predecessorOutputs.slice(0, DEFAULT_CONTEXT_PREDECESSOR_OUTPUT_LIMIT).map((item, index) => createPredecessorOutputContextItem(item, index, task))
    : [];
  items.push(...predecessorOutputItems);

  const taskItems = relatedContext.taskItems
    .filter((item) => {
      const contextId = item.contextId;
      return (!resumeHint || contextId !== resumeHint.metadata?.contextId)
        && (!rerunHint || contextId !== rerunHint.metadata?.contextId);
    })
    .slice(0, 1)
    .map((item, index) => mapStoredContextItem(item, 74 - index, 'adjacent'));
  const linkedStageItems = relatedContext.stageItems
    .slice(0, 1)
    .map((item) => mapStoredContextItem(item, 68, 'reference'));
  items.push(...taskItems, ...linkedStageItems);

  const memoryItems = Array.isArray(recalled?.items)
    ? recalled.items.slice(0, Math.max(1, recalled.items.length)).map((item, index) => createContextBundleItem({
        kind: 'memory-summary',
        priority: 72 - index,
        title: item.title || '未命名记忆',
        summary: item.summary || excerptText(item.content || '无内容'),
        content: excerptText(item.content || item.summary || '无内容', 220),
        sourceKind: item.sourceKind || null,
        sourceRef: item.sourceRef || item.memoryId || null,
        metadata: {
          memoryId: item.memoryId,
          matchedBy: item.matchedBy || null,
          authority: item.authority || 'low',
          hygiene: item.hygiene || null
        },
        hygieneLabel: item.hygieneLabel,
        sourceClass: item.sourceClass,
        allowedUse: item.allowedUse,
        promptAllowed: false,
        selectedBecause: buildMemorySelectionReasons(item, recalled),
        authority: 'adjacent'
      }))
    : [];
  items.push(...memoryItems);

  const selectedItems = items
    .sort((left, right) => right.priority - left.priority)
    .slice(0, Math.max(1, contextContext.limit));
  const hygieneSummary = buildContextHygieneSummary(selectedItems, items.length);

  return {
    items: selectedItems,
    summary: `Selected ${selectedItems.length} context items for task "${task.title}".`,
    content: formatContextSnapshotContent(selectedItems),
    metadata: {
      workflowId: state.workflow?.workflowId || null,
      taskId: task.taskId,
      candidateCount: items.length,
      selectedCount: selectedItems.length,
      recalledMemoryCount: Array.isArray(recalled?.items) ? recalled.items.length : 0,
      exactMemoryCount: Array.isArray(recalled?.exactItems) ? recalled.exactItems.length : 0,
      structuralMemoryCount: Array.isArray(recalled?.structuralItems) ? recalled.structuralItems.length : 0,
      graphMemoryCount: Array.isArray(recalled?.graphItems) ? recalled.graphItems.length : 0,
      semanticMemoryCount: Array.isArray(recalled?.semanticItems) ? recalled.semanticItems.length : 0,
      relatedContextCount: relatedContext.total,
      predecessorOutputCount: Array.isArray(predecessorOutputs) ? predecessorOutputs.length : 0,
      filteredPredecessorOutputCount: predecessorOutputs?.filteredOutputCount || 0,
      assignmentStatus: assignment?.assignmentStatus || null,
      preferredRole: assignment?.preferredRole || null,
      hasHandoff: Boolean(handoffContext?.current || handoffContext?.predecessors?.length),
      hasExecutionContext: Boolean(executionContext),
      executionToolCount: Array.isArray(executionContext?.tools) ? executionContext.tools.length : 0,
      executionMemoryEnabled: executionContext?.memory?.enabled === true,
      selectedKinds: [...new Set(selectedItems.map((item) => item.kind))],
      selectedAuthorities: [...new Set(selectedItems.map((item) => item.authority || 'reference'))],
      selectedReasons: [...new Set(selectedItems.flatMap((item) => item.selectedBecause || []))],
      hygieneSummary,
      hasResumeHint: selectedItems.some((item) => item.kind === 'resume-hint'),
      hasRerunHint: selectedItems.some((item) => item.kind === 'rerun-hint')
    }
  };
}

function createPredecessorOutputContextItem(item, index, task) {
  const output = item?.output || {};
  const classification = classifyTaskOutputForContext(output, {
    isRepairTask: isValidationRepairTask(task)
  });
  const title = output.name
    ? `${item?.predecessorTitle || '上游任务'} 输出：${output.name}`
    : `${item?.predecessorTitle || '上游任务'} 输出`;
  const summary = [output.kind || 'output', output.name, output.path]
    .filter(Boolean)
    .join('｜') || '上游任务输出。';
  const content = [
    `predecessorTaskId: ${item?.predecessorTaskId || '无'}`,
    `predecessorTitle: ${item?.predecessorTitle || '上游任务'}`,
    `outputId: ${output.outputId || '无'}`,
    `kind: ${output.kind || 'output'}`,
    `name: ${output.name || '无'}`,
    `path: ${output.path || '无'}`,
    `content: ${excerptText(output.content || '', 260)}`,
    `metadata: ${safeJson(output.metadata ?? null)}`
  ].join('\n');

  return createContextBundleItem({
    kind: 'predecessor-output',
    priority: 87 - index,
    title,
    summary,
    content,
    sourceKind: 'workflow-task-output',
    sourceRef: item?.predecessorTaskId || output.taskId || null,
    metadata: {
      predecessorTaskId: item?.predecessorTaskId || null,
      predecessorTitle: item?.predecessorTitle || null,
      outputId: output.outputId || null,
      outputKind: output.kind || null,
      outputName: output.name || null,
      path: output.path || null,
      outputMetadata: output.metadata ?? null,
      output,
      hygiene: buildHygieneMetadata({
        classification,
        provenance: {
          sourceKind: 'workflow-task-output',
          sourceRef: item?.predecessorTaskId || output.taskId || null,
          outputId: output.outputId || null
        }
      })
    },
    hygieneLabel: classification.hygieneLabel,
    sourceClass: classification.sourceClass,
    allowedUse: classification.allowedUse,
    promptAllowed: classification.promptAllowed,
    selectedBecause: ['predecessor-output'],
    authority: 'adjacent'
  });
}

function buildResumeHintContextItem(task, taskItems) {
  if (!Array.isArray(taskItems) || taskItems.length === 0) {
    return null;
  }

  const resumedItem = taskItems.find((item) => item?.metadata?.kind === 'resumed');
  if (!resumedItem) {
    return null;
  }

  const summary = resumedItem.metadata?.resumeMessage
    || resumedItem.summary
    || '任务已恢复并准备重试。';

  return createContextBundleItem({
    kind: 'resume-hint',
    priority: 89,
    title: '恢复信息',
    summary,
    content: [
      `resumeMessage: ${resumedItem.metadata?.resumeMessage || '无'}`,
      `previousStatus: ${resumedItem.metadata?.previousStatus || '无'}`,
      `blockedReason: ${resumedItem.metadata?.blockedReason || '无'}`,
      `lastError: ${resumedItem.metadata?.lastError || '无'}`,
      `resumePayload: ${safeJson(resumedItem.metadata?.resumePayload ?? null)}`
    ].join('\n'),
    sourceKind: resumedItem.sourceKind || null,
    sourceRef: resumedItem.sourceRef || resumedItem.contextId,
    metadata: {
      contextId: resumedItem.contextId,
      resumedTaskId: resumedItem.metadata?.resumedTaskId || resumedItem.taskId || null,
      resumeMessage: resumedItem.metadata?.resumeMessage || null,
      blockedReason: resumedItem.metadata?.blockedReason || null,
      lastError: resumedItem.metadata?.lastError || null,
      resumePayload: resumedItem.metadata?.resumePayload ?? null,
      updatedAt: resumedItem.updatedAt || null
    },
    selectedBecause: ['resume-message', 'resumed-context'],
    authority: 'adjacent'
  });
}

function buildRerunHintContextItem(taskItems) {
  if (!Array.isArray(taskItems) || taskItems.length === 0) {
    return null;
  }

  const rerunItem = taskItems.find((item) => item?.metadata?.kind === 'rerun');
  if (!rerunItem) {
    return null;
  }

  const descendantTaskIds = Array.isArray(rerunItem.metadata?.descendantTaskIds)
    ? rerunItem.metadata.descendantTaskIds.filter(Boolean)
    : [];
  const summary = rerunItem.metadata?.rerunReason
    || rerunItem.summary
    || '任务因上游纠错而重新执行。';

  return createContextBundleItem({
    kind: 'rerun-hint',
    priority: 96,
    title: '重跑信息',
    summary,
    content: [
      `rerunReason: ${rerunItem.metadata?.rerunReason || '无'}`,
      `rerunFingerprint: ${rerunItem.metadata?.rerunFingerprint || '无'}`,
      `rerunOperator: ${rerunItem.metadata?.rerunOperator || '无'}`,
      `previousStatus: ${rerunItem.metadata?.previousStatus || '无'}`,
      `previousDoneSummary: ${rerunItem.metadata?.previousDoneSummary || '无'}`,
      `previousBlockedReason: ${rerunItem.metadata?.previousBlockedReason || '无'}`,
      `lastError: ${rerunItem.metadata?.lastError || '无'}`,
      `descendantTaskIds: ${descendantTaskIds.length > 0 ? descendantTaskIds.join(', ') : '无'}`,
      `rerunPayload: ${safeJson(rerunItem.metadata?.rerunPayload ?? null)}`
    ].join('\n'),
    sourceKind: rerunItem.sourceKind || null,
    sourceRef: rerunItem.sourceRef || rerunItem.contextId,
    metadata: {
      contextId: rerunItem.contextId,
      rerunTaskId: rerunItem.metadata?.rerunTaskId || rerunItem.taskId || null,
      rerunId: rerunItem.metadata?.rerunId || null,
      rerunReason: rerunItem.metadata?.rerunReason || null,
      rerunFingerprint: rerunItem.metadata?.rerunFingerprint || null,
      rerunOperator: rerunItem.metadata?.rerunOperator || null,
      rerunPayload: rerunItem.metadata?.rerunPayload ?? null,
      descendantTaskIds,
      updatedAt: rerunItem.updatedAt || null
    },
    selectedBecause: ['rerun-reason', 'rerun-context'],
    authority: 'adjacent'
  });
}

function queryRelatedContextItems(contextSystem, contextContext, state, task) {
  if (!contextSystem) {
    return {
      taskItems: [],
      stageItems: [],
      total: 0
    };
  }

  const baseQuery = {
    scope: contextContext.scope,
    workflowId: task.workflowId
  };

  if (contextContext.projectKey) {
    baseQuery.projectKey = contextContext.projectKey;
  }

  if (contextContext.workspacePath) {
    baseQuery.workspacePath = contextContext.workspacePath;
  }

  if (contextContext.sessionId) {
    baseQuery.sessionId = contextContext.sessionId;
  }

  const taskItems = contextSystem.queryItems({
    ...baseQuery,
    taskId: task.taskId,
    limit: DEFAULT_TASK_CONTEXT_QUERY_LIMIT + 2
  }).items;

  const directPredecessorTaskIds = getCompletedPredecessors(state, task)
    .map((item) => item.taskId)
    .filter(Boolean);

  const predecessorStageItems = directPredecessorTaskIds.length > 0
    ? directPredecessorTaskIds.flatMap((predecessorTaskId) => contextSystem.queryItems({
        ...baseQuery,
        taskId: predecessorTaskId,
        limit: 1
      }).items)
    : [];

  const stageItems = predecessorStageItems.filter((item) => item.stageId || item.metadata?.kind === 'rerun' || item.metadata?.kind === 'resumed');

  return {
    taskItems,
    stageItems,
    total: taskItems.length + stageItems.length
  };
}

function mapStoredContextItem(item, priority, authority = 'reference') {
  return createContextBundleItem({
    kind: item.stageId ? 'stage-context' : 'task-context',
    priority,
    title: item.title || item.kind || '已保存上下文',
    summary: item.summary || excerptText(item.content || '无内容'),
    content: excerptText(item.content || item.summary || '无内容', 220),
    sourceKind: item.sourceKind || null,
    sourceRef: item.sourceRef || item.contextId,
    metadata: {
      contextId: item.contextId,
      stageId: item.stageId || null,
      taskId: item.taskId || null,
      updatedAt: item.updatedAt || null
    },
    selectedBecause: [item.stageId ? 'stage-context' : 'task-context'],
    authority
  });
}

function createContextBundleItem(input) {
  const baseItem = {
    kind: input.kind,
    priority: input.priority,
    title: input.title,
    summary: input.summary,
    content: input.content,
    sourceKind: input.sourceKind || null,
    sourceRef: input.sourceRef || null,
    metadata: input.metadata ?? null,
    selectedBecause: Array.isArray(input.selectedBecause) ? [...input.selectedBecause] : [],
    authority: input.authority || 'reference'
  };
  const classification = input.hygieneLabel
    ? {
        hygieneLabel: input.hygieneLabel,
        sourceClass: input.sourceClass,
        allowedUse: input.allowedUse,
        promptAllowed: input.promptAllowed !== false,
        trustState: input.metadata?.hygiene?.trustState || null,
        workflowGenerated: Boolean(input.metadata?.hygiene?.workflowGenerated),
        requiresPromotion: Boolean(input.metadata?.hygiene?.requiresPromotion)
      }
    : classifyContextItemForPrompt(baseItem);
  const hygiene = input.metadata?.hygiene || buildHygieneMetadata({
    classification,
    provenance: {
      sourceKind: baseItem.sourceKind,
      sourceRef: baseItem.sourceRef,
      kind: baseItem.kind
    }
  });

  return {
    ...baseItem,
    metadata: {
      ...(baseItem.metadata && typeof baseItem.metadata === 'object' && !Array.isArray(baseItem.metadata) ? baseItem.metadata : {}),
      hygiene
    },
    hygieneLabel: classification.hygieneLabel,
    sourceClass: classification.sourceClass,
    allowedUse: classification.allowedUse,
    promptAllowed: classification.promptAllowed
  };
}

function buildExecutionContextItems(executionContext) {
  if (!executionContext || typeof executionContext !== 'object') {
    return [];
  }

  const items = [];
  const tools = normalizeToolVisibilityList(executionContext.tools);
  const memory = normalizeMemoryBoundary(executionContext.memory);
  const workspace = normalizeWorkspaceContext(executionContext.workspace);

  if (tools.length > 0) {
    items.push(createContextBundleItem({
      kind: 'execution-tools',
      priority: 97,
      title: '默认工具可见性',
      summary: `已声明 ${tools.length} 个默认工具。`,
      content: tools.map((tool, index) => formatExecutionToolLine(tool, index)).join('\n'),
      metadata: {
        tools
      },
      selectedBecause: ['execution-tools'],
      authority: 'authoritative'
    }));
  }

  if (memory) {
    items.push(createContextBundleItem({
      kind: 'execution-memory',
      priority: 96,
      title: '活跃记忆上下文',
      summary: formatExecutionMemorySummary(memory),
      content: formatExecutionMemoryContent(memory),
      metadata: {
        memory
      },
      selectedBecause: ['execution-memory'],
      authority: 'authoritative'
    }));
  }

  if (workspace) {
    items.push(createContextBundleItem({
      kind: 'execution-workspace',
      priority: 95,
      title: '默认工作区约束',
      summary: formatExecutionWorkspaceSummary(workspace),
      content: formatExecutionWorkspaceContent(workspace),
      metadata: {
        workspace
      },
      selectedBecause: ['execution-workspace'],
      authority: 'authoritative'
    }));
  }

  return items;
}

function formatExecutionToolLine(tool, index) {
  const parts = [tool?.name || `tool-${index + 1}`];
  if (tool?.purpose) {
    parts.push(`purpose=${tool.purpose}`);
  }
  if (tool?.when) {
    parts.push(`when=${tool.when}`);
  }
  if (tool?.limits) {
    parts.push(`limits=${tool.limits}`);
  }
  return `${index + 1}. ${parts.join('｜')}`;
}

function formatExecutionMemorySummary(memory) {
  if (!memory || typeof memory !== 'object') {
    return '未声明默认记忆边界。';
  }

  if (memory.enabled === false) {
    return '默认记忆已禁用。';
  }

  return [
    memory.scope ? `scope=${memory.scope}` : null,
    memory.projectKey ? `project=${memory.projectKey}` : null,
    memory.workspacePath ? `workspace=${memory.workspacePath}` : null,
    memory.limit != null ? `limit=${memory.limit}` : null,
    `recalled=${memory.recalledCount ?? 0}`
  ].filter(Boolean).join('｜') || '默认记忆已启用。';
}

function formatExecutionMemoryContent(memory) {
  if (!memory || typeof memory !== 'object') {
    return 'enabled: false';
  }

  return [
    `enabled: ${memory.enabled !== false}`,
    `scope: ${memory.scope || '无'}`,
    `projectKey: ${memory.projectKey || '无'}`,
    `workspacePath: ${memory.workspacePath || '无'}`,
    `sessionId: ${memory.sessionId || '无'}`,
    `limit: ${memory.limit ?? '无'}`,
    `recalledCount: ${memory.recalledCount ?? 0}`,
    `query: ${safeJson(memory.query ?? null)}`
  ].join('\n');
}

function formatExecutionWorkspaceSummary(workspace) {
  if (!workspace || typeof workspace !== 'object') {
    return '未声明默认工作区。';
  }

  return [
    workspace.cwd ? `cwd=${workspace.cwd}` : null,
    workspace.path ? `path=${workspace.path}` : null,
    workspace.artifacts ? `artifacts=${workspace.artifacts}` : null
  ].filter(Boolean).join('｜') || '存在默认工作区约束。';
}

function formatExecutionWorkspaceContent(workspace) {
  if (!workspace || typeof workspace !== 'object') {
    return 'cwd: 无';
  }

  return [
    `cwd: ${workspace.cwd || '无'}`,
    `path: ${workspace.path || '无'}`,
    `artifacts: ${workspace.artifacts || '无'}`,
    `notes: ${workspace.notes || '无'}`
  ].join('\n');
}

function normalizeVisibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const tools = normalizeToolVisibilityList(value.tools);
  const memory = normalizeMemoryBoundary(value.memory);
  const workspace = normalizeWorkspaceContext(value.workspace);

  return tools.length > 0 || memory || workspace
    ? { tools, memory, workspace }
    : null;
}

function normalizeToolVisibilityList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeToolVisibility(item))
    .filter(Boolean);
}

function normalizeToolVisibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const tool = {
    name: normalizeOptionalText(value.name) || normalizeOptionalText(value.tool),
    purpose: normalizeOptionalText(value.purpose) || normalizeOptionalText(value.description),
    when: normalizeOptionalText(value.when) || normalizeOptionalText(value.usage),
    limits: normalizeOptionalText(value.limits) || normalizeOptionalText(value.boundary)
  };

  return tool.name || tool.purpose || tool.when || tool.limits
    ? tool
    : null;
}

function normalizeMemoryBoundary(value, fallback = null) {
  if (value == null) {
    return normalizeMemoryBoundaryFromObject(fallback);
  }

  if (value === false) {
    return {
      enabled: false,
      scope: null,
      projectKey: null,
      workspacePath: null,
      sessionId: null,
      limit: null,
      notes: null,
      query: fallback?.query || null,
      recalledCount: fallback?.recalledCount ?? 0
    };
  }

  const normalized = normalizeMemoryBoundaryFromObject(value);
  if (!normalized) {
    return normalizeMemoryBoundaryFromObject(fallback);
  }

  if (fallback && typeof fallback === 'object') {
    return {
      enabled: normalized.enabled !== false,
      scope: normalized.scope || fallback.scope || null,
      projectKey: normalized.projectKey || fallback.projectKey || null,
      workspacePath: normalized.workspacePath || fallback.workspacePath || null,
      sessionId: normalized.sessionId || fallback.sessionId || null,
      limit: normalized.limit ?? fallback.limit ?? null,
      notes: normalized.notes || fallback.notes || null,
      query: normalized.query || fallback.query || null,
      recalledCount: normalized.recalledCount ?? fallback.recalledCount ?? 0
    };
  }

  return normalized;
}

function normalizeMemoryBoundaryFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const limit = value.limit == null
    ? null
    : normalizeOptionalPositiveInteger(value.limit);
  const recalledCount = value.recalledCount == null
    ? null
    : normalizeOptionalPositiveInteger(value.recalledCount, { allowZero: true });
  const memory = {
    enabled: value.enabled !== false,
    scope: normalizeOptionalText(value.scope),
    projectKey: normalizeOptionalText(value.projectKey),
    workspacePath: normalizeOptionalText(value.workspacePath),
    sessionId: normalizeOptionalText(value.sessionId),
    limit,
    notes: normalizeOptionalText(value.notes),
    query: value.query && typeof value.query === 'object' && !Array.isArray(value.query) ? value.query : null,
    recalledCount
  };

  return memory.enabled === false
    || memory.scope
    || memory.projectKey
    || memory.workspacePath
    || memory.sessionId
    || memory.limit != null
    || memory.notes
    || memory.query
    || memory.recalledCount != null
    ? memory
    : null;
}

function normalizeWorkspaceContext(value, fallback = null) {
  const normalizedValue = normalizeWorkspaceContextObject(value);
  const normalizedFallback = normalizeWorkspaceContextObject(fallback);

  if (!normalizedValue) {
    return normalizedFallback;
  }

  if (!normalizedFallback) {
    return normalizedValue;
  }

  return {
    cwd: normalizedValue.cwd || normalizedFallback.cwd || null,
    path: normalizedValue.path || normalizedFallback.path || null,
    artifacts: normalizedValue.artifacts || normalizedFallback.artifacts || null,
    notes: normalizedValue.notes || normalizedFallback.notes || null
  };
}

function normalizeWorkspaceContextObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const workspace = {
    cwd: normalizeOptionalText(value.cwd),
    path: normalizeOptionalText(value.path),
    artifacts: normalizeOptionalText(value.artifacts),
    notes: normalizeOptionalText(value.notes)
  };

  return workspace.cwd || workspace.path || workspace.artifacts || workspace.notes
    ? workspace
    : null;
}


function formatContextSnapshotContent(items) {
  const lines = [];
  const currentTaskItems = items.filter((item) => item.kind === 'current-task');
  const lastErrorItems = items.filter((item) => item.kind === 'last-error');
  const resumeHintItems = items.filter((item) => item.kind === 'resume-hint');
  const rerunHintItems = items.filter((item) => item.kind === 'rerun-hint');
  const authoritativeExtras = items.filter((item) => item.authority === 'authoritative' && item.kind !== 'current-task');
  const adjacentItems = items.filter((item) => {
    if (item.authority !== 'adjacent') {
      return false;
    }

    return item.kind !== 'last-error'
      && item.kind !== 'resume-hint'
      && item.kind !== 'rerun-hint';
  });
  const referenceItems = items.filter((item) => item.authority === 'reference');

  pushSnapshotSection(lines, '当前执行焦点：', currentTaskItems, { style: 'bullet' });
  pushSnapshotSection(lines, '当前任务事实：', authoritativeExtras);
  pushSnapshotSection(lines, '最近错误 / 阻塞：', lastErrorItems, { style: 'bullet' });
  pushSnapshotSection(lines, '恢复信息：', resumeHintItems);
  pushSnapshotSection(lines, '重跑信息：', rerunHintItems);
  pushSnapshotSection(lines, '直接相关上下文：', adjacentItems);
  pushSnapshotSection(lines, '参考信息（低优先级）：', referenceItems);

  return lines.join('\n').trim();
}

function pushSnapshotSection(lines, title, items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  const style = options.style === 'bullet' ? 'bullet' : 'numbered';
  lines.push(title);

  for (const [index, item] of items.entries()) {
    const prefix = style === 'bullet' ? '-' : `${index + 1}.`;
    lines.push(`${prefix} ${item.title}｜${item.summary}`);
  }

  lines.push('');
}


function writeTaskContextSnapshot(contextSystem, contextContext, workflow, task, contextBundle) {
  if (!contextSystem || !contextContext.enabled || !workflow?.workflowId || !task?.taskId || !contextBundle?.content) {
    return null;
  }

  const snapshotResult = contextSystem.writeSnapshot({
    scope: contextContext.scope,
    projectKey: contextContext.projectKey,
    workspacePath: contextContext.workspacePath,
    sessionId: contextContext.sessionId,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    sourceKind: WORKFLOW_TASK_SNAPSHOT_KIND,
    sourceRef: createWorkflowTaskSourceRef(workflow.workflowId, task.taskId),
    title: `Task context snapshot ${task.title}`,
    summary: contextBundle.summary,
    content: contextBundle.content,
    items: contextBundle.items,
    metadata: contextBundle.metadata
  });
  return snapshotResult?.snapshot ?? null;
}

function writeTaskLifecycleMemory(memorySystem, memoryContext, workflow, task, input = {}) {
  if (!memorySystem || !memoryContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  const sourceRef = createWorkflowTaskSourceRef(workflow.workflowId, task.taskId);
  const lifecyclePolicy = shouldWriteLifecycleMemory(input);
  if (!lifecyclePolicy.shouldWrite) {
    return null;
  }

  const summary = buildTaskMemorySummary(task, input);
  const content = buildTaskMemoryContent(workflow, task, input);

  return upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowTaskLifecycle',
    type: lifecyclePolicy.type,
    scope: memoryContext.scope,
    title: `Workflow task ${task.title}`,
    summary,
    content,
    projectKey: memoryContext.projectKey,
    workspacePath: memoryContext.workspacePath,
    sessionId: memoryContext.sessionId,
    tags: buildLifecycleMemoryTags(buildTaskMemoryTags(task, input.kind), lifecyclePolicy),
    sourceKind: WORKFLOW_TASK_SOURCE_KIND,
    sourceRef,
    subjectKind: WORKFLOW_TASK_SOURCE_KIND,
    subjectRef: sourceRef,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    eventKind: input.kind || 'blocked',
    structureJson: {
      workflowId: workflow.workflowId,
      taskId: task.taskId,
      taskTitle: task.title,
      taskStatus: task.status,
      eventKind: input.kind || 'blocked',
      runnerId: input.runnerId || null,
      prompt: input.prompt || null,
      doneSummary: task.doneSummary || null,
      blockedReason: task.blockedReason || null,
      lastError: task.lastError || input.error || null,
      adapterPayload: getPersistentAdapterPayload(input),
      contextSnapshotId: input.contextSnapshot?.snapshotId || null,
      contextItemCount: Array.isArray(input.contextItems) ? input.contextItems.length : 0
    },
    stability: lifecyclePolicy.stability,
    confidence: lifecyclePolicy.confidence,
    message: appendLifecycleHygieneMessage(buildTaskMemoryMessage(task, input.kind), lifecyclePolicy)
  });
}

function writeTaskLifecycleContext(contextSystem, contextContext, workflow, task, input = {}) {
  if (!contextSystem || !contextContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  const contextResult = upsertContextItemBySource(contextSystem, {
    kind: WORKFLOW_TASK_CONTEXT_KIND,
    scope: contextContext.scope,
    projectKey: contextContext.projectKey,
    workspacePath: contextContext.workspacePath,
    sessionId: contextContext.sessionId,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    sourceKind: WORKFLOW_TASK_SOURCE_KIND,
    sourceRef: createWorkflowTaskSourceRef(workflow.workflowId, task.taskId),
    title: `Workflow task ${task.title}`,
    summary: buildTaskMemorySummary(task, input),
    content: buildTaskContextContent(workflow, task, input),
    metadata: {
      runnerId: input.runnerId || null,
      kind: input.kind || null,
      contextSnapshotId: input.contextSnapshot?.snapshotId || null,
      contextItemCount: Array.isArray(input.contextItems) ? input.contextItems.length : 0,
      adapterPayload: getPersistentAdapterPayload(input),
      error: input.error || null
    },
    priority: resolveTaskContextPriority(input.kind)
  });
  return contextResult?.item ?? null;
}

function buildTaskRecallText(state, task, assignment, handoffContext) {
  const parts = [
    state?.workflow?.goal,
    state?.workflow?.instruction,
    task?.title,
    task?.description,
    task?.lastError,
    assignment?.preferredRole,
    assignment?.assignmentReason,
    assignment?.requiredCapabilities?.join(' '),
    handoffContext?.current?.summary
  ];

  const dependencies = Array.isArray(state?.dependencies) ? state.dependencies : [];
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const predecessorSummaries = dependencies
    .filter((dependency) => dependency.successorTaskId === task.taskId)
    .map((dependency) => tasks.find((item) => item.taskId === dependency.predecessorTaskId))
    .filter((item) => item?.doneSummary)
    .map((item) => item.doneSummary);
  const predecessorHandoffs = Array.isArray(handoffContext?.predecessors)
    ? handoffContext.predecessors
      .map((item) => item?.handoff?.summary)
      .filter(Boolean)
    : [];

  parts.push(...predecessorSummaries, ...predecessorHandoffs);
  return parts.filter(Boolean).join(' ');
}

function buildActiveMemoryContext(memoryContext, recalled) {
  const normalizedMemoryContext = normalizeMemoryBoundary(memoryContext);
  if (!normalizedMemoryContext) {
    return {
      enabled: false,
      scope: null,
      projectKey: null,
      workspacePath: null,
      sessionId: null,
      limit: null,
      query: recalled?.query || null,
      recalledCount: Array.isArray(recalled?.items) ? recalled.items.length : 0
    };
  }

  return {
    enabled: normalizedMemoryContext.enabled !== false,
    scope: normalizedMemoryContext.scope,
    projectKey: normalizedMemoryContext.projectKey,
    workspacePath: normalizedMemoryContext.workspacePath,
    sessionId: normalizedMemoryContext.sessionId,
    limit: normalizedMemoryContext.limit,
    query: recalled?.query || null,
    recalledCount: Array.isArray(recalled?.items) ? recalled.items.length : 0
  };
}

function buildExecutionContext({ agentIdentity, activeMemoryContext, contextContext } = {}) {
  const identity = normalizeAgentIdentity(agentIdentity);
  const visibility = normalizeVisibility(identity?.visibility);
  const workspace = normalizeWorkspaceContext(visibility?.workspace, contextContext);
  const memory = normalizeMemoryBoundary(visibility?.memory, activeMemoryContext);
  const tools = normalizeToolVisibilityList(visibility?.tools);

  if (!identity && !workspace && !memory && tools.length === 0) {
    return null;
  }

  return {
    agent: identity,
    tools,
    memory,
    workspace
  };
}

function resolveAgentIdentity(task, runnerId, baseAgentIdentity = null) {
  if (!task) {
    return baseAgentIdentity;
  }

  const fallbackAgentId = normalizeOptionalText(task.ownerAgentId) || normalizeOptionalText(runnerId);
  const fallbackRole = normalizeOptionalText(task.preferredRole);
  const fallbackCapabilities = normalizeOptionalStringArray(task.requiredCapabilities);

  if (baseAgentIdentity) {
    return {
      agentId: normalizeOptionalText(baseAgentIdentity.agentId) || fallbackAgentId,
      name: normalizeOptionalText(baseAgentIdentity.name) || normalizeOptionalText(baseAgentIdentity.agentId) || fallbackAgentId,
      role: normalizeOptionalText(baseAgentIdentity.role) || fallbackRole,
      capabilities: normalizeOptionalStringArray(baseAgentIdentity.capabilities).length > 0
        ? normalizeOptionalStringArray(baseAgentIdentity.capabilities)
        : fallbackCapabilities,
      visibility: normalizeVisibility(baseAgentIdentity.visibility)
    };
  }

  if (!fallbackAgentId && !fallbackRole && fallbackCapabilities.length === 0) {
    return null;
  }

  return {
    agentId: fallbackAgentId,
    name: fallbackAgentId,
    role: fallbackRole,
    capabilities: fallbackCapabilities,
    visibility: null
  };
}

function normalizeAgentIdentity(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const agentId = normalizeOptionalText(value.agentId);
  const name = normalizeOptionalText(value.name) || agentId;
  const role = normalizeOptionalText(value.role);
  const capabilities = normalizeOptionalStringArray(value.capabilities);
  const visibility = normalizeVisibility(value.visibility);

  if (!agentId && !name && !role && capabilities.length === 0 && !visibility) {
    return null;
  }

  return {
    agentId,
    name,
    role,
    capabilities,
    visibility
  };
}

function resolveEffectiveMemoryContext(memoryContext, agentIdentity) {
  const visibility = normalizeVisibility(agentIdentity?.visibility);
  return normalizeMemoryBoundary(visibility?.memory, memoryContext);
}

function buildTaskAssignment(task) {
  if (!task) {
    return null;
  }

  const assignment = {
    ownerAgentId: normalizeOptionalText(task.ownerAgentId),
    preferredRole: normalizeOptionalText(task.preferredRole),
    requiredCapabilities: normalizeOptionalStringArray(task.requiredCapabilities),
    assignmentStatus: normalizeOptionalText(task.assignmentStatus) || 'unassigned',
    assignmentReason: normalizeOptionalText(task.assignmentReason)
  };

  return hasAssignmentContent(assignment) ? assignment : null;
}

function buildTaskHandoffContext(state, task) {
  if (!task) {
    return null;
  }

  const current = normalizeStructuredHandoff(task.handoff, {
    sourceRef: createWorkflowTaskSourceRef(task.workflowId, task.taskId)
  });
  const predecessors = getCompletedPredecessors(state, task)
    .map((item) => ({
      taskId: item.taskId,
      title: item.title,
      doneSummary: item.doneSummary || '无完成摘要。',
      handoff: normalizeStructuredHandoff(item.handoff, {
        fallbackSummary: item.doneSummary || '无完成摘要。',
        sourceRef: createWorkflowTaskSourceRef(item.workflowId, item.taskId)
      })
    }))
    .filter((item) => item.handoff);

  if (!current && predecessors.length === 0) {
    return null;
  }

  return { current, predecessors };
}

function writeAssignmentLifecycleMemory(memorySystem, memoryContext, workflow, task, input = {}) {
  if (!memorySystem || !memoryContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  if (!hasAssignmentContent(input.assignment) && !input.handoff) {
    return null;
  }

  const lifecyclePolicy = shouldWriteLifecycleMemory(input);
  if (!lifecyclePolicy.shouldWrite) {
    return null;
  }

  const sourceRef = createWorkflowAssignmentSourceRef(workflow.workflowId, task.taskId);
  return upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowAssignmentLifecycle',
    type: lifecyclePolicy.type,
    scope: memoryContext.scope,
    title: `Workflow assignment ${task.title}`,
    summary: buildAssignmentMemorySummary(task, input),
    content: buildAssignmentMemoryContent(workflow, task, input),
    projectKey: memoryContext.projectKey,
    workspacePath: memoryContext.workspacePath,
    sessionId: memoryContext.sessionId,
    tags: buildLifecycleMemoryTags(buildAssignmentMemoryTags(task, input.kind), lifecyclePolicy),
    sourceKind: WORKFLOW_ASSIGNMENT_SOURCE_KIND,
    sourceRef,
    subjectKind: WORKFLOW_ASSIGNMENT_SOURCE_KIND,
    subjectRef: sourceRef,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    eventKind: input.kind || 'blocked',
    structureJson: {
      workflowId: workflow.workflowId,
      taskId: task.taskId,
      taskTitle: task.title,
      eventKind: input.kind || 'blocked',
      assignment: input.assignment || null,
      handoff: input.handoff || null,
      runnerId: input.runnerId || null,
      error: input.error || null
    },
    stability: lifecyclePolicy.stability,
    confidence: lifecyclePolicy.confidence,
    message: appendLifecycleHygieneMessage(buildAssignmentMemoryMessage(task, input.kind), lifecyclePolicy)
  });
}

function writeAssignmentLifecycleContext(contextSystem, contextContext, workflow, task, input = {}) {
  if (!contextSystem || !contextContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  if (!hasAssignmentContent(input.assignment) && !input.handoff) {
    return null;
  }

  return upsertContextItemBySource(contextSystem, {
    kind: WORKFLOW_ASSIGNMENT_CONTEXT_KIND,
    scope: contextContext.scope,
    projectKey: contextContext.projectKey,
    workspacePath: contextContext.workspacePath,
    sessionId: contextContext.sessionId,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    sourceKind: WORKFLOW_ASSIGNMENT_SOURCE_KIND,
    sourceRef: createWorkflowAssignmentSourceRef(workflow.workflowId, task.taskId),
    title: `Workflow assignment ${task.title}`,
    summary: buildAssignmentMemorySummary(task, input),
    content: buildAssignmentContextContent(workflow, task, input),
    metadata: {
      runnerId: input.runnerId || null,
      kind: input.kind || null,
      assignmentStatus: input.assignment?.assignmentStatus || null,
      preferredRole: input.assignment?.preferredRole || null,
      handoffSummary: input.handoff?.summary || null,
      error: input.error || null
    },
    priority: resolveAssignmentContextPriority(input.kind)
  }).item;
}

function hasAssignmentContent(assignment) {
  if (!assignment || typeof assignment !== 'object') {
    return false;
  }

  return Boolean(
    assignment.ownerAgentId
    || assignment.preferredRole
    || assignment.assignmentReason
    || (Array.isArray(assignment.requiredCapabilities) && assignment.requiredCapabilities.length > 0)
    || (assignment.assignmentStatus && assignment.assignmentStatus !== 'unassigned')
  );
}

function formatAssignmentContent(assignment) {
  if (!assignment) {
    return '无';
  }

  return [
    `ownerAgentId: ${assignment.ownerAgentId || '无'}`,
    `preferredRole: ${assignment.preferredRole || '无'}`,
    `requiredCapabilities: ${Array.isArray(assignment.requiredCapabilities) && assignment.requiredCapabilities.length > 0 ? assignment.requiredCapabilities.join(', ') : '无'}`,
    `assignmentStatus: ${assignment.assignmentStatus || '无'}`,
    `assignmentReason: ${assignment.assignmentReason || '无'}`
  ].join('\n');
}

function formatHandoffContent(handoff, fallbackSummary = null) {
  const normalized = normalizeStructuredHandoff(handoff, { fallbackSummary });
  if (!normalized) {
    return fallbackSummary || '无';
  }

  const lines = [
    `summary: ${normalized.summary || fallbackSummary || '无'}`
  ];

  if (normalized.artifacts.length > 0) {
    lines.push(`artifacts: ${normalized.artifacts.join('；')}`);
  }

  if (normalized.decisions.length > 0) {
    lines.push(`decisions: ${normalized.decisions.join('；')}`);
  }

  if (normalized.openQuestions.length > 0) {
    lines.push(`openQuestions: ${normalized.openQuestions.join('；')}`);
  }

  if (normalized.risks.length > 0) {
    lines.push(`risks: ${normalized.risks.join('；')}`);
  }

  if (normalized.recommendedNextRole) {
    lines.push(`recommendedNextRole: ${normalized.recommendedNextRole}`);
  }

  if (normalized.sourceRef) {
    lines.push(`sourceRef: ${normalized.sourceRef}`);
  }

  return lines.join('\n');
}

function resolveTaskSemanticLaneLimit(input = {}) {
  if (!input.enabled) {
    return 0;
  }

  if (input.limit == null) {
    return DEFAULT_TASK_CONTEXT_QUERY_LIMIT;
  }

  const limit = normalizeOptionalPositiveInteger(input.limit) || 0;
  if (limit <= 0) {
    return 0;
  }

  return Math.min(DEFAULT_TASK_CONTEXT_QUERY_LIMIT, Math.max(1, Math.floor(limit / 2)));
}

function normalizeOptionalStringArray(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeOptionalText(item))
    .filter(Boolean);
}

function normalizeOptionalPositiveInteger(value, options = {}) {
  if (value == null) {
    return null;
  }

  const number = Number(value);
  const allowZero = options.allowZero === true;
  if (!Number.isFinite(number)) {
    return null;
  }

  if (allowZero) {
    return number < 0 ? null : Math.floor(number);
  }

  return number <= 0 ? null : Math.floor(number);
}

function buildAssignmentMemorySummary(task, input = {}) {
  if (input.kind === 'done') {
    return input.handoff?.summary
      || input.assignment?.assignmentReason
      || `Assignment for task "${task.title}" completed.`;
  }

  if (input.kind === 'error') {
    return input.error || `Assignment for task "${task.title}" failed in runner.`;
  }

  return input.handoff?.summary
    || task.blockedReason
    || task.lastError
    || `Assignment for task "${task.title}" is blocked.`;
}

function buildAssignmentMemoryContent(workflow, task, input = {}) {
  return [
    `workflowId: ${workflow.workflowId}`,
    `taskId: ${task.taskId}`,
    `taskTitle: ${task.title}`,
    `taskStatus: ${task.status}`,
    `runnerId: ${input.runnerId || '无'}`,
    `kind: ${input.kind || '无'}`,
    'assignment:',
    indentBlock(formatAssignmentContent(input.assignment)),
    'handoff:',
    indentBlock(formatHandoffContent(input.handoff, task.doneSummary || task.blockedReason || task.title)),
    `error: ${input.error || '无'}`
  ].join('\n');
}

function buildAssignmentContextContent(workflow, task, input = {}) {
  return [
    `workflowId: ${workflow.workflowId}`,
    `taskId: ${task.taskId}`,
    `taskTitle: ${task.title}`,
    `taskStatus: ${task.status}`,
    `runnerId: ${input.runnerId || '无'}`,
    `kind: ${input.kind || '无'}`,
    'assignment:',
    indentBlock(formatAssignmentContent(input.assignment)),
    'handoff:',
    indentBlock(formatHandoffContent(input.handoff, task.doneSummary || task.blockedReason || task.title)),
    `error: ${input.error || '无'}`
  ].join('\n');
}

function buildAssignmentMemoryTags(task, kind) {
  const tags = ['workflow', 'assignment', 'task', task.status];
  if (kind) {
    tags.push(kind);
  }
  return [...new Set(tags)];
}

function buildLifecycleMemoryTags(tags, lifecyclePolicy) {
  return [...new Set([
    ...(Array.isArray(tags) ? tags : []),
    'workflow-generated',
    lifecyclePolicy.hygieneLabel,
    lifecyclePolicy.sourceClass,
    lifecyclePolicy.requiresPromotion ? 'requires-promotion' : 'validated-promoted'
  ].filter(Boolean))];
}

function appendLifecycleHygieneMessage(message, lifecyclePolicy) {
  const suffix = [
    `hygiene=${lifecyclePolicy.hygieneLabel}`,
    `allowedUse=${lifecyclePolicy.allowedUse}`,
    lifecyclePolicy.requiresPromotion ? 'requiresPromotion=true' : 'requiresPromotion=false'
  ].join('; ');
  return `${message} ${suffix}`;
}

function buildAssignmentMemoryMessage(task, kind) {
  if (kind === 'done') {
    return `Updated workflow-assignment memory after completing "${task.title}".`;
  }

  if (kind === 'error') {
    return `Updated workflow-assignment memory after runner error on "${task.title}".`;
  }

  return `Updated workflow-assignment memory after blocking "${task.title}".`;
}

function resolveAssignmentContextPriority(kind) {
  if (kind === 'error') {
    return 99;
  }

  if (kind === 'blocked') {
    return 97;
  }

  if (kind === 'done') {
    return 91;
  }

  return 93;
}

function indentBlock(value, indent = '  ') {
  return String(value || '无')
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function getCompletedPredecessors(state, task) {
  const dependencies = Array.isArray(state?.dependencies) ? state.dependencies : [];
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];

  return dependencies
    .filter((dependency) => dependency.successorTaskId === task.taskId)
    .map((dependency) => tasks.find((item) => item.taskId === dependency.predecessorTaskId))
    .filter((item) => item?.status === 'done');
}

function getRecentRunLogs(state) {
  return Array.isArray(state?.runLogs)
    ? state.runLogs.slice(-DEFAULT_CONTEXT_LOG_LIMIT).reverse()
    : [];
}

function buildTaskMemorySummary(task, input = {}) {
  if (input.kind === 'done') {
    return task.doneSummary || `Task "${task.title}" completed.`;
  }

  if (input.kind === 'error') {
    return input.error || task.lastError || `Task "${task.title}" failed in runner.`;
  }

  return task.blockedReason || task.lastError || `Task "${task.title}" is blocked.`;
}

function buildTaskMemoryContent(workflow, task, input = {}) {
  return [
    `workflowId: ${workflow.workflowId}`,
    `taskId: ${task.taskId}`,
    `workflowGoal: ${workflow.goal}`,
    `workflowInstruction: ${workflow.instruction}`,
    `taskTitle: ${task.title}`,
    `taskDescription: ${task.description || '无'}`,
    `taskStatus: ${task.status}`,
    `attemptCount: ${task.attemptCount || 0}`,
    `doneSummary: ${task.doneSummary || '无'}`,
    `blockedReason: ${task.blockedReason || '无'}`,
    `lastError: ${task.lastError || '无'}`,
    `runnerId: ${input.runnerId || '无'}`,
    `adapterPayload: ${safeJson(getPersistentAdapterPayload(input))}`,
    `prompt: ${input.prompt || '无'}`
  ].join('\n');
}

function buildTaskContextContent(workflow, task, input = {}) {
  return [
    `workflowId: ${workflow.workflowId}`,
    `taskId: ${task.taskId}`,
    `workflowGoal: ${workflow.goal}`,
    `workflowInstruction: ${workflow.instruction}`,
    `taskTitle: ${task.title}`,
    `taskDescription: ${task.description || '无'}`,
    `taskStatus: ${task.status}`,
    `attemptCount: ${task.attemptCount || 0}`,
    `doneSummary: ${task.doneSummary || '无'}`,
    `blockedReason: ${task.blockedReason || '无'}`,
    `lastError: ${task.lastError || input.error || '无'}`,
    `runnerId: ${input.runnerId || '无'}`,
    `contextSnapshotId: ${input.contextSnapshot?.snapshotId || '无'}`,
    `contextSnapshotSummary: ${input.contextSnapshot?.summary || '无'}`,
    `contextItemCount: ${Array.isArray(input.contextItems) ? input.contextItems.length : 0}`,
    `adapterPayload: ${safeJson(getPersistentAdapterPayload(input))}`,
    `prompt: ${input.prompt || '无'}`
  ].join('\n');
}

function buildTaskMemoryTags(task, kind) {
  const tags = ['workflow', 'task', task.status];
  if (kind) {
    tags.push(kind);
  }
  return [...new Set(tags)];
}

function buildTaskMemoryMessage(task, kind) {
  if (kind === 'done') {
    return `Updated workflow-task memory after completing "${task.title}".`;
  }

  if (kind === 'error') {
    return `Updated workflow-task memory after runner error on "${task.title}".`;
  }

  return `Updated workflow-task memory after blocking "${task.title}".`;
}

function resolveTaskContextPriority(kind) {
  if (kind === 'error') {
    return 98;
  }

  if (kind === 'blocked') {
    return 96;
  }

  if (kind === 'done') {
    return 90;
  }

  return 92;
}

function resolveTaskTimeoutPolicy(task, defaults = {}) {
  const contract = task?.contract && typeof task.contract === 'object' && !Array.isArray(task.contract)
    ? task.contract
    : null;

  return {
    executionTimeoutMs: normalizeOptionalNonNegativeInteger(
      contract?.executionTimeoutMs,
      normalizeNonNegativeInteger(defaults.executionTimeoutMs, DEFAULT_TASK_EXECUTION_TIMEOUT_MS, 'Task execution timeout'),
      'Task execution timeout'
    ),
    stalledTimeoutMs: normalizeOptionalNonNegativeInteger(
      contract?.stalledTimeoutMs,
      normalizeNonNegativeInteger(defaults.stalledTimeoutMs, DEFAULT_TIMEOUT_SWEEP_STALLED_MS, 'Task stalled timeout'),
      'Task stalled timeout'
    ),
    maxAttempts: normalizeOptionalNonNegativeInteger(
      contract?.maxTimeoutAttempts,
      defaults.maxAttempts ?? DEFAULT_TIMEOUT_SWEEP_MAX_ATTEMPTS,
      'Task timeout max attempts'
    ),
    timeoutReason: normalizeOptionalText(contract?.timeoutReason)
      || normalizeOptionalText(defaults.timeoutReason)
      || DEFAULT_TIMEOUT_SWEEP_REASON
  };
}

function resolveAdapter(adapter) {
  if (adapter?.run && typeof adapter.run === 'function') {
    return adapter;
  }

  if (typeof adapter === 'function') {
    return createAgentAdapter(adapter);
  }

  throw new Error('Workflow runner requires an adapter with a run() method or a function handler.');
}

function normalizeRunnerId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || `runner-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function normalizePositiveInteger(value, fallback, label) {
  if (value == null) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return Math.floor(number);
}

async function runMaintenance({ engine, workflowId, timeoutSweepMaxExecutionMs, timeoutSweepStalledMs, timeoutSweepMaxAttempts, timeoutSweepIntervalMs, timeoutSweepReason, updateLastTimeoutSweepAt, getLastTimeoutSweepAt }) {
  const shouldSweep = shouldRunTimeoutSweep({
    timeoutSweepMaxExecutionMs,
    timeoutSweepStalledMs,
    timeoutSweepIntervalMs,
    lastTimeoutSweepAt: getLastTimeoutSweepAt?.() || 0
  });

  const released = await engine.releaseExpiredTaskLeases({ workflowId });

  let swept = { releasedTaskCount: 0, blockedTaskCount: 0 };
  if (shouldSweep) {
    swept = await engine.sweepTimedOutTasks({
      workflowId,
      maxExecutionMs: timeoutSweepMaxExecutionMs || undefined,
      stalledMs: timeoutSweepStalledMs || undefined,
      maxAttempts: timeoutSweepMaxAttempts ?? undefined,
      reason: timeoutSweepReason
    });
    updateLastTimeoutSweepAt?.(Date.now());
  }

  return { released, swept };
}

function shouldRunTimeoutSweep({ timeoutSweepIntervalMs, lastTimeoutSweepAt }) {
  if (timeoutSweepIntervalMs <= 0) {
    return true;
  }

  return Date.now() - lastTimeoutSweepAt >= timeoutSweepIntervalMs;
}

function normalizeNonNegativeInteger(value, fallback, label) {
  return normalizeOptionalNonNegativeInteger(value, fallback, label);
}

function normalizeOptionalNonNegativeInteger(value, fallback, label) {
  if (value == null) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }

  return Math.floor(number);
}

class TaskExecutionTimeoutError extends Error {
  constructor({ timeoutMs, workflowId, taskId, attemptCount }) {
    super(`Task execution timed out after ${timeoutMs}ms.`);
    this.name = 'TaskExecutionTimeoutError';
    this.failureType = FAILURE_TYPES.timeout;
    this.timeoutMs = timeoutMs;
    this.workflowId = workflowId;
    this.taskId = taskId;
    this.attemptCount = attemptCount;
  }
}

function runWithExecutionTimeout(promise, input = {}) {
  const timeoutMs = Number(input.timeoutMs || 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TaskExecutionTimeoutError({
        timeoutMs: Math.floor(timeoutMs),
        workflowId: input.workflowId,
        taskId: input.taskId,
        attemptCount: input.attemptCount
      }));
    }, Math.floor(timeoutMs));
  });

  return Promise.race([promise, timeout])
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
}

function normalizeObjectOption(value, label) {
  if (value == null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function isLeaseLostBeforeFinalizeError(error) {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message === 'Task lease is no longer owned by the expected runner.'
    || error.message === 'Task is no longer doing under the expected runner lease.';
}

function classifyTaskExecutionFailure({ error, task, retryPolicy, timeoutPolicy }) {
  if (error?.failureType === FAILURE_TYPES.timeout) {
    return classifyTimeoutFailure({
      task,
      timeoutKind: FAILURE_TYPES.timeout,
      timeoutMs: error.timeoutMs,
      policy: retryPolicy,
      maxAttempts: timeoutPolicy?.maxAttempts
    });
  }

  return classifyExecutionFailure({ error, task, policy: retryPolicy });
}

function normalizeErrorAdapterPayload(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return null;
  }

  const payload = error.adapterPayload && typeof error.adapterPayload === 'object' && !Array.isArray(error.adapterPayload)
    ? error.adapterPayload
    : error.payload && typeof error.payload === 'object' && !Array.isArray(error.payload)
      ? error.payload
      : null;
  return payload ? { ...payload } : null;
}

function defaultStatusMessage(taskTitle, status) {
  if (status === 'done') {
    return `Runner completed task "${taskTitle}".`;
  }

  return `Runner blocked task "${taskTitle}".`;
}

function excerptText(value, maxLength = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text || '无内容';
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function safeJson(value) {
  return value == null ? 'null' : JSON.stringify(value);
}
