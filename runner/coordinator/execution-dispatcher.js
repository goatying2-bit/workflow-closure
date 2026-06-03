import { createAgentWorkflowChain } from '../workflow-chain.js';
import { createAgentWorkflowWrapper } from '../workflow-wrapper.js';
import { createWorkflowRunner } from '../workflow-runner.js';
import {
  DEFAULT_MAX_WORKFLOW_STEPS,
  buildStageCandidate,
  buildTaskCandidate,
  getTransientRecoveryStatus,
  loadAssignmentTarget,
  mergeStringArrays,
  normalizeOptionalText,
  normalizePositiveInteger,
  normalizeStructuredHandoff,
  resolveRuntimeAdapter,
  structuredHandoffsEqual
} from './shared.js';

export function createExecutionDispatcher({
  options,
  engine,
  agentStore,
  workflowStore,
  chainStore,
  runtimeAdapters,
  assignmentService
}) {
  return {
    async runNextAssignment(input = {}) {
      return runNextAssignment({
        input,
        options,
        engine,
        agentStore,
        workflowStore,
        chainStore,
        runtimeAdapters,
        assignmentService
      });
    },
    async resumeAssignedWork(input = {}) {
      return resumeAssignedWork({
        input,
        options,
        engine,
        agentStore,
        workflowStore,
        chainStore,
        runtimeAdapters,
        assignmentService
      });
    }
  };
}

async function runNextAssignment({ input, options, engine, agentStore, workflowStore, chainStore, runtimeAdapters, assignmentService }) {
  const prepared = await resolvePreparedAssignment({
    input,
    agentStore,
    workflowStore,
    chainStore,
    assignmentService
  });

  if (prepared.status !== 'assigned') {
    return prepared;
  }

  const { assignment, agent, target } = prepared;
  const adapter = resolveRuntimeAdapter({ input, agent, runtimeAdapters, resolver: options.resolveAgentAdapter });
  if (!adapter) {
    throw new Error(`Agent "${agent.agentId}" is missing a runtime adapter.`);
  }

  assignmentService.markAssignmentAccepted({ assignment, target, agent });

  try {
    if (target.targetType === 'stage') {
      return await runStageAssignment({
        input,
        options,
        engine,
        agentStore,
        chainStore,
        assignment,
        agent,
        target,
        adapter,
        assignmentService
      });
    }

    return await runTaskAssignment({
      input,
      options,
      engine,
      agentStore,
      workflowStore,
      assignment,
      agent,
      target,
      adapter,
      assignmentService
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentStore.updateAssignment({
      assignmentId: assignment.assignmentId,
      status: 'blocked',
      reason: message,
      payload: {
        ...assignment.payload,
        error: message
      }
    });
    throw error;
  }
}

async function resumeAssignedWork({ input, options, engine, agentStore, workflowStore, chainStore, runtimeAdapters, assignmentService }) {
  const targetState = assignmentService.resolveBlockedTarget(input);

  if (!targetState) {
    return {
      status: 'idle',
      mode: 'auto',
      reason: 'no_blocked_work',
      assignment: null,
      target: null,
      agent: null
    };
  }

  const mode = input.mode == null ? 'auto' : input.mode;
  const normalizedMode = mode === 'resume' || mode === 'reassign' ? mode : 'auto';
  const latestAssignment = assignmentService.getLatestAssignmentForTarget(targetState);
  const runNow = input.runNow === true;
  const resumeMessage = normalizeOptionalText(input.message);
  const resumePayload = input.payload ?? null;
  const recoveryStatus = getTransientRecoveryStatus(targetState);

  if (recoveryStatus?.phase === 'cooldown') {
    return {
      status: 'cooldown',
      mode: normalizedMode === 'reassign' ? 'reassign' : 'resume',
      reason: 'transient_recovery_cooldown',
      assignment: latestAssignment,
      target: targetState,
      agent: latestAssignment ? agentStore.getAgent(latestAssignment.agentId) : null,
      workflow: targetState.workflow || null,
      stage: targetState.targetType === 'stage' ? targetState.stage || targetState : null,
      task: targetState.targetType === 'task' ? targetState.task || targetState : targetState.task || null,
      recovery: recoveryStatus.recovery,
      recoveryStatus,
      waitMs: recoveryStatus.waitMs,
      nextEligibleRetryAt: recoveryStatus.nextEligibleRetryAt
    };
  }

  if (normalizedMode === 'reassign' || (normalizedMode === 'auto' && normalizeOptionalText(input.agentId) && input.agentId !== latestAssignment?.agentId)) {
    const resumed = await resumeBlockedTarget({
      target: targetState,
      resumeMessage,
      resumePayload,
      workflowStore,
      chainStore,
      options,
      engine
    });
    assignmentService.releaseAssignmentForReassign({
      target: resumed.target,
      assignment: latestAssignment,
      input
    });

    const reassigned = await assignmentService.assignNextWork({
      ...input,
      targetType: resumed.target.targetType,
      workflowId: resumed.target.workflowId,
      chainId: resumed.target.chainId,
      stageId: resumed.target.stageId,
      taskId: resumed.target.taskId,
      reason: normalizeOptionalText(input.reason) || `Reassigned ${resumed.target.targetType} "${resumed.target.title}" after resume.`
    });

    if (reassigned.status !== 'assigned') {
      return {
        status: 'resumed',
        mode: 'reassign',
        assignment: null,
        target: resumed.target,
        agent: null,
        workflow: resumed.workflow || null,
        stage: resumed.stage || null,
        task: resumed.task || null,
        recovery: recoveryStatus?.recovery || null,
        recoveryStatus: recoveryStatus || null
      };
    }

    if (!runNow) {
      return {
        status: 'reassigned',
        mode: 'reassign',
        assignment: reassigned.assignment,
        target: reassigned.target,
        agent: reassigned.agent,
        workflow: resumed.workflow || null,
        stage: resumed.stage || null,
        task: resumed.task || null,
        recovery: recoveryStatus?.recovery || null,
        recoveryStatus: recoveryStatus || null
      };
    }

    return runNextAssignment({
      input: {
        assignmentId: reassigned.assignment.assignmentId,
        maxStages: input.maxStages,
        maxWorkflowSteps: input.maxWorkflowSteps,
        maxTaskRetries: input.maxTaskRetries
      },
      options,
      engine,
      agentStore,
      workflowStore,
      chainStore,
      runtimeAdapters,
      assignmentService
    });
  }

  const resumed = await resumeBlockedTarget({
    target: targetState,
    resumeMessage,
    resumePayload,
    workflowStore,
    chainStore,
    options,
    engine
  });

  const assignment = assignmentService.markAssignmentResumed({
    target: resumed.target,
    assignment: latestAssignment,
    input
  });

  if (!runNow || !assignment) {
    return {
      status: 'resumed',
      mode: 'resume',
      assignment,
      target: resumed.target,
      agent: assignment ? agentStore.getAgent(assignment.agentId) : null,
      workflow: resumed.workflow || null,
      stage: resumed.stage || null,
      task: resumed.task || null,
      recovery: recoveryStatus?.recovery || null,
      recoveryStatus: recoveryStatus || null
    };
  }

  return runNextAssignment({
    input: {
      assignmentId: assignment.assignmentId,
      maxStages: input.maxStages,
      maxWorkflowSteps: input.maxWorkflowSteps,
      maxTaskRetries: input.maxTaskRetries
    },
    options,
    engine,
    agentStore,
    workflowStore,
    chainStore,
    runtimeAdapters,
    assignmentService
  });
}

async function resolvePreparedAssignment({ input, agentStore, workflowStore, chainStore, assignmentService }) {
  const assignmentId = normalizeOptionalText(input.assignmentId);
  if (assignmentId) {
    const assignment = agentStore.getAssignment(assignmentId);
    if (!assignment) {
      throw new Error(`Assignment not found: ${assignmentId}`);
    }

    const agent = agentStore.getAgent(assignment.agentId);
    if (!agent) {
      throw new Error(`Assigned agent not found: ${assignment.agentId}`);
    }

    const target = loadAssignmentTarget({ assignment, workflowStore, chainStore });
    if (!target) {
      throw new Error(`Assignment target not found: ${assignment.targetType}:${assignment.targetId}`);
    }

    if (assignment.status !== 'assigned' && assignment.status !== 'accepted') {
      throw new Error(`Assignment ${assignment.assignmentId} is not runnable from status ${assignment.status}.`);
    }

    return {
      status: 'assigned',
      assignment,
      agent,
      target
    };
  }

  return assignmentService.assignNextWork(input);
}

async function runTaskAssignment({ input, options, engine, agentStore, workflowStore, assignment, agent, target, adapter, assignmentService }) {
  const runner = await createWorkflowRunner({
    ...options,
    engine,
    workflowId: target.workflowId,
    taskId: target.taskId,
    ownerAgentId: agent.agentId,
    assignmentStatus: 'accepted',
    runnerId: agent.agentId,
    agentIdentity: agent,
    adapter,
    ...(input.maxTaskRetries != null ? { maxTaskRetries: input.maxTaskRetries } : {}),
    ...(input.taskExecutionTimeoutMs != null ? { taskExecutionTimeoutMs: input.taskExecutionTimeoutMs } : {})
  });

  let currentAssignment = assignment;

  while (true) {
    const step = await runner.runOnce();

    if (step.status === 'idle') {
      agentStore.updateAssignment({
        assignmentId: currentAssignment.assignmentId,
        status: 'released',
        reason: `No ready task remained for workflow ${target.workflowId}.`,
        payload: {
          ...currentAssignment.payload,
          workflowId: target.workflowId,
          stepStatus: step.status
        }
      });

      return {
        status: 'idle',
        reason: 'no_ready_task',
        assignment: agentStore.getAssignment(currentAssignment.assignmentId),
        agent,
        target: loadAssignmentTarget({
          assignment: currentAssignment,
          workflowStore,
          chainStore
        })
      };
    }

    if (step.task?.taskId && step.task.taskId !== target.taskId) {
      throw new Error(`Assignment ${currentAssignment.assignmentId} expected task ${target.taskId} but runner executed ${step.task.taskId}.`);
    }

    currentAssignment = assignmentService.finalizeAssignmentAfterRun({
      assignment: currentAssignment,
      agent,
      target,
      status: step.status,
      payload: {
        ...currentAssignment.payload,
        stepStatus: step.status,
        workflowId: step.workflow?.workflowId || target.workflowId,
        taskId: step.task?.taskId || target.taskId,
        handoff: step.handoff || step.task?.handoff || null
      }
    });

    persistTaskHandoffRecord({
      engine,
      agentStore,
      assignment: currentAssignment,
      agent,
      target,
      task: step.task,
      workflow: step.workflow
    });

    if (step.status !== 'ready') {
      return {
        status: step.status,
        assignment: currentAssignment,
        agent,
        target: buildTaskCandidate(step.task),
        workflow: step.workflow,
        step,
        handoff: step.handoff || step.task?.handoff || null
      };
    }
  }
}

async function runStageAssignment({ input, options, engine, agentStore, chainStore, assignment, agent, target, adapter, assignmentService }) {
  const chain = await createAgentWorkflowChain({
    ...options,
    engine,
    runnerId: agent.agentId,
    agentIdentity: agent,
    adapter
  });
  const result = await chain.runNextStage({
    chainId: target.chainId,
    taskId: target.taskId,
    maxWorkflowSteps: normalizePositiveInteger(input.maxWorkflowSteps, DEFAULT_MAX_WORKFLOW_STEPS, 'maxWorkflowSteps')
  });
  const state = chain.getChainState({
    chainId: target.chainId,
    includeWorkflowStates: true
  });
  const stage = state.stages.find((item) => item.stageId === target.stageId) || chainStore.getChainStage(target.chainId, target.stageId);
  const nextStage = state.nextStage || null;
  const handoff = buildStageHandoff({
    stage,
    workflowResult: result.workflowResult,
    nextStage
  });

  let stageWithHandoff = stage;
  if (handoff && !structuredHandoffsEqual(stage?.handoff, handoff)) {
    const updated = chainStore.advanceChainStage({
      chainId: stage.chainId,
      stageId: stage.stageId,
      status: stage.status,
      workflowId: stage.workflowId,
      blockedReason: stage.blockedReason,
      doneSummary: stage.doneSummary,
      ownerAgentId: stage.ownerAgentId,
      preferredRole: stage.preferredRole,
      requiredCapabilities: stage.requiredCapabilities,
      assignmentStatus: stage.assignmentStatus,
      assignmentReason: stage.assignmentReason,
      handoff,
      action: 'chain_stage_handoff_updated',
      message: `Updated stage handoff for "${stage.title}".`,
      payload: {
        assignmentId: assignment.assignmentId,
        handoff
      }
    });
    stageWithHandoff = updated.stage;
  }

  const executedWorkflow = result.workflowResult?.workflow || null;
  const executedTask = findLatestWorkflowTask(result.workflowResult);
  const currentAssignment = assignmentService.finalizeAssignmentAfterRun({
    assignment,
    agent,
    target,
    status: result.status,
    payload: {
      ...assignment.payload,
      chainId: target.chainId,
      stageId: target.stageId,
      workflowId: stageWithHandoff?.workflowId || target.workflowId || null,
      taskId: executedTask?.taskId || target.taskId || assignment.payload?.taskId || null,
      resumedTaskId: target.taskId || assignment.payload?.resumedTaskId || assignment.payload?.taskId || null,
      resultStatus: result.status,
      handoff
    }
  });

  const reportedTarget = buildStageCandidate(state.chain, stageWithHandoff, {
    taskId: executedTask?.taskId || target.taskId || assignment.payload?.taskId || null
  });

  persistTaskHandoffRecord({
    engine,
    agentStore,
    assignment: currentAssignment,
    agent,
    target: reportedTarget,
    task: executedTask,
    workflow: executedWorkflow
  });

  persistStageHandoffRecord({
    agentStore,
    assignment: currentAssignment,
    agent,
    stage: stageWithHandoff,
    nextStage,
    handoff
  });

  return {
    status: result.status,
    assignment: currentAssignment,
    agent,
    target: reportedTarget,
    chain: state.chain,
    stage: stageWithHandoff,
    workflowResult: result.workflowResult,
    step: result.lastStep,
    handoff
  };
}

async function resumeBlockedTarget({ target, resumeMessage, resumePayload, workflowStore, chainStore, options, engine }) {
  if (target.targetType === 'stage') {
    const chain = await createAgentWorkflowChain({
      ...options,
      engine
    });
    const blockedTaskId = resolveBlockedStageTaskId(workflowStore, chainStore, target);
    const resumed = await chain.resumeChainStage({
      chainId: target.chainId,
      stageId: target.stageId,
      taskId: blockedTaskId,
      message: resumeMessage,
      payload: resumePayload
    });
    const stage = resumed.state.stages.find((item) => item.stageId === target.stageId) || resumed.stage;
    return {
      target: buildStageCandidate(resumed.chain, stage, { taskId: blockedTaskId }),
      stage,
      task: resumed.task,
      workflow: resumed.workflow
    };
  }

  const wrapper = await createAgentWorkflowWrapper({
    ...options,
    engine
  });
  const resumed = await wrapper.resumeTask({
    workflowId: target.workflowId,
    taskId: target.taskId,
    message: resumeMessage,
    payload: resumePayload
  });
  const task = resumed.state.tasks.find((item) => item.taskId === target.taskId) || resumed.task;
  return {
    target: buildTaskCandidate(task, resumed.workflow),
    task,
    workflow: resumed.workflow
  };
}

function resolveBlockedStageTaskId(workflowStore, chainStore, target) {
  const chainState = chainStore.getChainState(target.chainId, { includeRunLogs: false });
  const stage = chainState.stages.find((item) => item.stageId === target.stageId);
  if (!stage?.workflowId) {
    throw new Error(`Blocked stage ${target.stageId} is missing workflowId.`);
  }

  const workflowState = workflowStore.getWorkflowState(stage.workflowId);
  const blockedTask = workflowState.tasks.find((item) => item.status === 'blocked');
  if (!blockedTask) {
    throw new Error(`Blocked task not found for stage ${target.stageId}.`);
  }

  return blockedTask.taskId;
}

function persistTaskHandoffRecord({ engine, agentStore, assignment, agent, target, task, workflow }) {
  const handoff = normalizeStructuredHandoff(task?.handoff);
  if (!handoff?.summary || !task?.taskId || !workflow?.workflowId) {
    return null;
  }

  const outputs = engine.listTaskOutputs({
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    limit: 100
  });

  return agentStore.createHandoff({
    fromAgentId: agent.agentId,
    toAgentId: null,
    sourceType: 'task',
    sourceId: task.taskId,
    workflowId: workflow.workflowId,
    chainId: target?.chainId || null,
    stageId: target?.stageId || null,
    summary: handoff.summary,
    artifacts: handoff.artifacts,
    artifactRefs: buildTaskHandoffArtifactRefs(outputs),
    decisions: handoff.decisions,
    openQuestions: handoff.openQuestions,
    risks: handoff.risks,
    recommendedNextRole: handoff.recommendedNextRole,
    status: assignment.status === 'completed' ? 'open' : 'open'
  });
}

function buildTaskHandoffArtifactRefs(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    return [];
  }

  const refs = [];
  for (const output of outputs) {
    if (!output || typeof output !== 'object') {
      continue;
    }

    const metadata = output.metadata && typeof output.metadata === 'object' && !Array.isArray(output.metadata)
      ? output.metadata
      : null;
    const artifactRef = normalizeOptionalText(metadata?.artifactRef);
    const path = normalizeOptionalText(output.path);
    const outputId = normalizeOptionalText(output.outputId);

    if (!artifactRef && !path && !outputId) {
      continue;
    }

    refs.push({
      artifactRef,
      outputId,
      name: normalizeOptionalText(output.name),
      kind: normalizeOptionalText(output.kind),
      path,
      storageStatus: normalizeOptionalText(metadata?.storageStatus),
      relativePath: normalizeOptionalText(metadata?.relativePath),
      workspacePath: normalizeOptionalText(metadata?.workspacePath)
    });
  }

  return refs;
}

function persistStageHandoffRecord({ agentStore, assignment, agent, stage, nextStage, handoff }) {
  const normalized = normalizeStructuredHandoff(handoff);
  if (!normalized?.summary || !stage?.stageId) {
    return null;
  }

  return agentStore.createHandoff({
    fromAgentId: agent.agentId,
    toAgentId: null,
    sourceType: 'stage',
    sourceId: stage.stageId,
    workflowId: stage.workflowId || null,
    chainId: stage.chainId,
    stageId: stage.stageId,
    summary: normalized.summary,
    artifacts: normalized.artifacts,
    decisions: normalized.decisions,
    openQuestions: normalized.openQuestions,
    risks: normalized.risks,
    recommendedNextRole: normalized.recommendedNextRole || nextStage?.preferredRole || null,
    status: assignment.status === 'completed' ? 'open' : 'open'
  });
}

function buildStageHandoff({ stage, workflowResult, nextStage }) {
  const lastWorkflowHandoff = findLatestWorkflowHandoff(workflowResult);

  const fallbackSummary = stage?.blockedReason
    || stage?.doneSummary
    || (stage ? `Stage "${stage.title}" ${stage.status === 'done' ? 'completed' : 'blocked'}.` : null);

  return normalizeStructuredHandoff({
    summary: stage?.status === 'blocked'
      ? fallbackSummary || lastWorkflowHandoff?.summary
      : lastWorkflowHandoff?.summary || fallbackSummary,
    artifacts: mergeStringArrays(lastWorkflowHandoff?.artifacts),
    decisions: mergeStringArrays(lastWorkflowHandoff?.decisions),
    openQuestions: mergeStringArrays(lastWorkflowHandoff?.openQuestions),
    risks: mergeStringArrays(
      lastWorkflowHandoff?.risks,
      stage?.status === 'blocked' && stage.blockedReason ? [stage.blockedReason] : []
    ),
    recommendedNextRole: nextStage?.preferredRole || lastWorkflowHandoff?.recommendedNextRole || null
  });
}

function findLatestWorkflowHandoff(workflowResult) {
  const directHandoff = normalizeStructuredHandoff(
    workflowResult?.lastStep?.handoff
      || workflowResult?.lastStep?.task?.handoff
  );

  if (directHandoff) {
    return directHandoff;
  }

  const steps = Array.isArray(workflowResult?.steps) ? workflowResult.steps : [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    const handoff = normalizeStructuredHandoff(step?.handoff || step?.task?.handoff);
    if (handoff) {
      return handoff;
    }
  }

  const tasks = Array.isArray(workflowResult?.state?.tasks) ? workflowResult.state.tasks : [];
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    const task = tasks[index];
    const handoff = normalizeStructuredHandoff(task?.handoff);
    if (handoff) {
      return handoff;
    }
  }

  return null;
}

function findLatestWorkflowTask(workflowResult) {
  const directTask = workflowResult?.lastStep?.task;
  if (directTask?.taskId) {
    return directTask;
  }

  const steps = Array.isArray(workflowResult?.steps) ? workflowResult.steps : [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const task = steps[index]?.task;
    if (task?.taskId) {
      return task;
    }
  }

  const tasks = Array.isArray(workflowResult?.state?.tasks) ? workflowResult.state.tasks : [];
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    const task = tasks[index];
    if (task?.taskId && task.status === 'done') {
      return task;
    }
  }

  return null;
}
