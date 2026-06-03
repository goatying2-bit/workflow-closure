import { createWorkflowEngine } from '../core/workflow-engine.js';
import {
  resolveAgentMemorySystem,
  resolveMemoryIntegrationContext,
  upsertMemoryBySource,
  createWorkflowTaskSourceRef
} from './memory-system.js';
import {
  resolveAgentContextSystem,
  resolveContextIntegrationContext,
  upsertContextItemBySource
} from './context-system.js';
import { createWorkflowRunner } from './workflow-runner.js';
import { createWorkflowWorkerPool } from './worker-pool.js';

const DEFAULT_MAX_STEPS = 100;
const WORKFLOW_TASK_SOURCE_KIND = 'workflow-task';
const WORKFLOW_TASK_RERUN_SOURCE_KIND = 'workflow-task-rerun';
const WORKFLOW_TASK_CONTEXT_KIND = 'workflow-task-lifecycle';
const WORKFLOW_TASK_RERUN_CONTEXT_KIND = 'workflow-task-rerun';

export async function createAgentWorkflowWrapper(options = {}) {
  const engine = options.engine || await createWorkflowEngine(options);
  const memorySystem = await resolveAgentMemorySystem(options);
  const memoryContext = resolveMemoryIntegrationContext(options);
  const contextSystem = await resolveAgentContextSystem(options);
  const contextContext = resolveContextIntegrationContext(options);

  return {
    async runInstruction(input = {}) {
      const { workflowInput, maxSteps, workerOptions } = normalizeRunInstructionInput(input);
      const created = engine.createWorkflowFromInstruction(workflowInput);

      return runWorkflowLoop({
        engine,
        runnerOptions: {
          ...options,
          ...workerOptions,
          memorySystem,
          contextSystem
        },
        workflowId: created.workflow.workflowId,
        maxSteps
      });
    },
    async runWorkflow(input = {}) {
      const workflowId = normalizeRequiredText(input.workflowId, 'Workflow id');
      const { workerOptions, runnerTargetingOptions } = normalizeRunWorkflowInput(input);
      return runWorkflowLoop({
        engine,
        runnerOptions: {
          ...options,
          ...workerOptions,
          ...runnerTargetingOptions,
          memorySystem,
          contextSystem
        },
        workflowId,
        maxSteps: input.maxSteps
      });
    },
    restartFromTask(input = {}) {
      const workflowId = normalizeRequiredText(input.workflowId, 'Workflow id');
      const taskId = normalizeRequiredText(input.taskId, 'Task id');
      const reason = normalizeRequiredText(input.reason, 'Rerun reason');
      const fingerprint = normalizeOptionalText(input.fingerprint);
      const operator = normalizeOptionalText(input.operator);
      const payload = input.payload ?? null;
      const maxSameFingerprintReruns = input.maxSameFingerprintReruns;
      const state = engine.getWorkflowState({ workflowId });
      const task = state.tasks.find((item) => item.taskId === taskId);

      if (!task) {
        throw new Error(`Task not found in workflow: ${taskId}`);
      }

      const restarted = engine.restartFromTask({
        workflowId,
        taskId,
        reason,
        fingerprint,
        operator,
        payload,
        maxSameFingerprintReruns
      });

      writeRerunTaskMemory(memorySystem, memoryContext, restarted.workflow, restarted.task, {
        rerun: restarted.rerun,
        descendants: restarted.descendants,
        previousTask: task,
        payload
      });
      writeRerunTaskContext(contextSystem, contextContext, restarted.workflow, restarted.task, {
        rerun: restarted.rerun,
        descendants: restarted.descendants,
        previousTask: task,
        payload
      });
      return restarted;
    },
    resumeTask(input = {}) {
      const workflowId = normalizeRequiredText(input.workflowId, 'Workflow id');
      const taskId = normalizeRequiredText(input.taskId, 'Task id');
      const state = engine.getWorkflowState({ workflowId });
      const task = state.tasks.find((item) => item.taskId === taskId);

      if (!task) {
        throw new Error(`Task not found in workflow: ${taskId}`);
      }

      if (task.status !== 'blocked') {
        throw new Error('Only blocked tasks can be resumed.');
      }

      const resumed = engine.advanceTaskStatus({
        workflowId,
        taskId,
        status: 'ready',
        lastError: task.lastError || task.blockedReason || null,
        reasonCode: null,
        action: 'task_resumed',
        message: normalizeOptionalText(input.message) || `Resumed blocked task "${task.title}".`,
        payload: input.payload ?? null
      });
      const nextState = engine.getWorkflowState({ workflowId });

      writeResumedTaskMemory(memorySystem, memoryContext, nextState.workflow, resumed.task, {
        message: normalizeOptionalText(input.message),
        payload: input.payload ?? null,
        previousTask: task
      });
      writeResumedTaskContext(contextSystem, contextContext, nextState.workflow, resumed.task, {
        message: normalizeOptionalText(input.message),
        payload: input.payload ?? null,
        previousTask: task
      });

      return {
        workflow: nextState.workflow,
        task: resumed.task,
        nextTask: nextState.nextTask || null,
        state: nextState
      };
    },
    getWorkflowState(input = {}) {
      const workflowId = normalizeRequiredText(input.workflowId, 'Workflow id');
      return engine.getWorkflowState({
        workflowId,
        query: input.query || {}
      });
    }

  };
}

async function runWorkflowLoop({ engine, runnerOptions, workflowId, maxSteps }) {
  const workerCount = normalizeWorkerCount(runnerOptions.workerCount);

  if (workerCount > 1) {
    const pool = await createWorkflowWorkerPool({
      ...runnerOptions,
      engine,
      workflowId,
      workerCount
    });
    const drained = await pool.drain({
      maxRounds: maxSteps,
      maxTaskRuns: runnerOptions.maxTaskRuns,
      stopOnBlocked: runnerOptions.stopOnBlocked
    });
    const state = drained.finalState || engine.getWorkflowState({ workflowId });

    return {
      status: drained.status,
      workflow: state.workflow,
      state,
      steps: drained.steps,
      lastStep: drained.lastStep,
      rounds: drained.rounds,
      workerCount,
      poolId: drained.poolId,
      runnerIds: pool.runnerIds
    };
  }

  const normalizedMaxSteps = normalizeMaxSteps(maxSteps);
  const runner = await createWorkflowRunner({
    ...runnerOptions,
    engine,
    workflowId
  });
  const steps = [];

  while (steps.length < normalizedMaxSteps) {
    const step = await runner.runOnce();
    steps.push(step);

    if (step.status === 'blocked') {
      return buildWorkflowLoopResult(engine, workflowId, steps, 'blocked');
    }

    if (step.status === 'idle') {
      const state = engine.getWorkflowState({ workflowId });
      const status = state.workflow.status === 'done' ? 'done' : 'idle';
      return buildWorkflowLoopResultFromState(state, steps, status);
    }
  }

  throw new Error(`Workflow loop exceeded maxSteps (${normalizedMaxSteps}) for workflow ${workflowId}.`);
}

function writeResumedTaskMemory(memorySystem, memoryContext, workflow, task, input = {}) {
  if (!memorySystem || !memoryContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  const sourceRef = createWorkflowTaskSourceRef(workflow.workflowId, task.taskId);
  return upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowTaskResumed',
    type: 'feedback',
    scope: memoryContext.scope,
    title: `Workflow task ${task.title}`,
    summary: `Task "${task.title}" resumed and is ready to retry.`,
    content: [
      `workflowId: ${workflow.workflowId}`,
      `taskId: ${task.taskId}`,
      `taskTitle: ${task.title}`,
      `taskStatus: ${task.status}`,
      `previousStatus: ${input.previousTask?.status || '无'}`,
      `blockedReason: ${input.previousTask?.blockedReason || '无'}`,
      `lastError: ${task.lastError || '无'}`,
      `resumeMessage: ${input.message || '无'}`,
      `resumePayload: ${input.payload == null ? 'null' : JSON.stringify(input.payload)}`
    ].join('\n'),
    projectKey: memoryContext.projectKey,
    workspacePath: memoryContext.workspacePath,
    sessionId: memoryContext.sessionId,
    tags: ['workflow', 'task', 'ready', 'resumed'],
    sourceKind: WORKFLOW_TASK_SOURCE_KIND,
    sourceRef,
    subjectKind: WORKFLOW_TASK_SOURCE_KIND,
    subjectRef: sourceRef,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    eventKind: 'resumed',
    structureJson: {
      workflowId: workflow.workflowId,
      taskId: task.taskId,
      taskTitle: task.title,
      taskStatus: task.status,
      previousStatus: input.previousTask?.status || null,
      blockedReason: input.previousTask?.blockedReason || null,
      lastError: task.lastError || null,
      resumeMessage: normalizeOptionalText(input.message),
      resumePayload: input.payload ?? null
    },
    stability: 'volatile',
    confidence: 0.85,
    message: `Updated workflow-task memory after resuming "${task.title}".`
  });
}

function writeResumedTaskContext(contextSystem, contextContext, workflow, task, input = {}) {
  if (!contextSystem || !contextContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  const resumeMessage = normalizeOptionalText(input.message);
  const resumePayload = input.payload ?? null;

  return upsertContextItemBySource(contextSystem, {
    kind: WORKFLOW_TASK_CONTEXT_KIND,
    scope: contextContext.scope,
    title: `Workflow task ${task.title}`,
    summary: `Task "${task.title}" resumed and is ready to retry.`,
    content: [
      `workflowId: ${workflow.workflowId}`,
      `taskId: ${task.taskId}`,
      `taskTitle: ${task.title}`,
      `taskStatus: ${task.status}`,
      `previousStatus: ${input.previousTask?.status || '无'}`,
      `blockedReason: ${input.previousTask?.blockedReason || '无'}`,
      `lastError: ${task.lastError || '无'}`,
      `resumeMessage: ${resumeMessage || '无'}`,
      `resumePayload: ${resumePayload == null ? 'null' : JSON.stringify(resumePayload)}`
    ].join('\n'),
    projectKey: contextContext.projectKey,
    workspacePath: contextContext.workspacePath,
    sessionId: contextContext.sessionId,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    sourceKind: WORKFLOW_TASK_SOURCE_KIND,
    sourceRef: createWorkflowTaskSourceRef(workflow.workflowId, task.taskId),
    metadata: {
      kind: 'resumed',
      previousStatus: input.previousTask?.status || null,
      blockedReason: input.previousTask?.blockedReason || null,
      lastError: task.lastError || null,
      resumeMessage,
      resumePayload,
      resumedTaskId: task.taskId
    },
    priority: 95
  });
}

function writeRerunTaskMemory(memorySystem, memoryContext, workflow, task, input = {}) {
  if (!memorySystem || !memoryContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  const rerun = input.rerun || {};
  const descendants = Array.isArray(input.descendants) ? input.descendants : [];
  const rerunPayload = input.payload ?? rerun.payload ?? null;
  const descendantTaskIds = descendants.map((item) => item.taskId).filter(Boolean);
  const sourceRef = createWorkflowTaskSourceRef(workflow.workflowId, task.taskId);

  return upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowTaskRerun',
    type: 'feedback',
    scope: memoryContext.scope,
    title: `Workflow rerun ${task.title}`,
    summary: `Task "${task.title}" restarted from rerun origin and is ready to retry.`,
    content: [
      `workflowId: ${workflow.workflowId}`,
      `taskId: ${task.taskId}`,
      `taskTitle: ${task.title}`,
      `taskStatus: ${task.status}`,
      `rerunId: ${rerun.rerunId || '无'}`,
      `rerunReason: ${rerun.reason || task.lastError || '无'}`,
      `rerunFingerprint: ${rerun.fingerprint || '无'}`,
      `rerunOperator: ${rerun.operator || '无'}`,
      `previousStatus: ${input.previousTask?.status || '无'}`,
      `previousDoneSummary: ${input.previousTask?.doneSummary || '无'}`,
      `previousBlockedReason: ${input.previousTask?.blockedReason || '无'}`,
      `lastError: ${task.lastError || '无'}`,
      `rerunPayload: ${rerunPayload == null ? 'null' : JSON.stringify(rerunPayload)}`,
      `affectedDescendantCount: ${descendantTaskIds.length}`,
      `affectedDescendantTaskIds: ${descendantTaskIds.length > 0 ? descendantTaskIds.join(', ') : '无'}`
    ].join('\n'),
    projectKey: memoryContext.projectKey,
    workspacePath: memoryContext.workspacePath,
    sessionId: memoryContext.sessionId,
    tags: ['workflow', 'task', 'ready', 'rerun'],
    sourceKind: WORKFLOW_TASK_RERUN_SOURCE_KIND,
    sourceRef,
    subjectKind: WORKFLOW_TASK_RERUN_SOURCE_KIND,
    subjectRef: sourceRef,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    eventKind: 'rerun',
    structureJson: {
      workflowId: workflow.workflowId,
      taskId: task.taskId,
      taskTitle: task.title,
      taskStatus: task.status,
      rerunId: rerun.rerunId || null,
      rerunReason: rerun.reason || task.lastError || null,
      rerunFingerprint: rerun.fingerprint || null,
      rerunOperator: rerun.operator || null,
      previousStatus: input.previousTask?.status || null,
      previousDoneSummary: input.previousTask?.doneSummary || null,
      previousBlockedReason: input.previousTask?.blockedReason || null,
      lastError: task.lastError || null,
      rerunPayload,
      descendantTaskIds,
      descendantTaskCount: descendantTaskIds.length
    },
    stability: 'volatile',
    confidence: 0.85,
    message: `Updated workflow-task rerun memory for "${task.title}".`
  });
}

function writeRerunTaskContext(contextSystem, contextContext, workflow, task, input = {}) {
  if (!contextSystem || !contextContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  const rerun = input.rerun || {};
  const descendants = Array.isArray(input.descendants) ? input.descendants : [];
  const rerunPayload = input.payload ?? rerun.payload ?? null;
  const descendantTaskIds = descendants.map((item) => item.taskId).filter(Boolean);

  return upsertContextItemBySource(contextSystem, {
    kind: WORKFLOW_TASK_RERUN_CONTEXT_KIND,
    scope: contextContext.scope,
    title: `Workflow rerun ${task.title}`,
    summary: `Task "${task.title}" restarted from rerun origin and is ready to retry.`,
    content: [
      `workflowId: ${workflow.workflowId}`,
      `taskId: ${task.taskId}`,
      `taskTitle: ${task.title}`,
      `taskStatus: ${task.status}`,
      `rerunId: ${rerun.rerunId || '无'}`,
      `rerunReason: ${rerun.reason || task.lastError || '无'}`,
      `rerunFingerprint: ${rerun.fingerprint || '无'}`,
      `rerunOperator: ${rerun.operator || '无'}`,
      `previousStatus: ${input.previousTask?.status || '无'}`,
      `previousDoneSummary: ${input.previousTask?.doneSummary || '无'}`,
      `previousBlockedReason: ${input.previousTask?.blockedReason || '无'}`,
      `lastError: ${task.lastError || '无'}`,
      `rerunPayload: ${rerunPayload == null ? 'null' : JSON.stringify(rerunPayload)}`,
      `affectedDescendantCount: ${descendantTaskIds.length}`,
      `affectedDescendantTaskIds: ${descendantTaskIds.length > 0 ? descendantTaskIds.join(', ') : '无'}`
    ].join('\n'),
    projectKey: contextContext.projectKey,
    workspacePath: contextContext.workspacePath,
    sessionId: contextContext.sessionId,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    sourceKind: WORKFLOW_TASK_RERUN_SOURCE_KIND,
    sourceRef: createWorkflowTaskSourceRef(workflow.workflowId, task.taskId),
    metadata: {
      kind: 'rerun',
      rerunId: rerun.rerunId || null,
      rerunReason: rerun.reason || task.lastError || null,
      rerunFingerprint: rerun.fingerprint || null,
      rerunOperator: rerun.operator || null,
      rerunPayload,
      previousStatus: input.previousTask?.status || null,
      previousDoneSummary: input.previousTask?.doneSummary || null,
      previousBlockedReason: input.previousTask?.blockedReason || null,
      lastError: task.lastError || null,
      descendantTaskIds,
      descendantTaskCount: descendantTaskIds.length,
      rerunTaskId: task.taskId
    },
    priority: 96
  });
}

function buildWorkflowLoopResult(engine, workflowId, steps, status) {
  const state = engine.getWorkflowState({ workflowId });
  return buildWorkflowLoopResultFromState(state, steps, status);
}

function buildWorkflowLoopResultFromState(state, steps, status) {
  return {
    status,
    workflow: state.workflow,
    state,
    steps,
    lastStep: steps.length > 0 ? steps[steps.length - 1] : null
  };
}

function normalizeRunInstructionInput(input) {
  if (typeof input === 'string') {
    return {
      workflowInput: input,
      maxSteps: undefined,
      workerOptions: {}
    };
  }

  if (!input || typeof input !== 'object') {
    throw new Error('Instruction input is required.');
  }

  const { maxSteps, ...rest } = input;
  const { workflowInput, workerOptions } = splitWorkflowAndWorkerOptions(rest);
  return {
    workflowInput,
    maxSteps,
    workerOptions
  };
}

function normalizeRunWorkflowInput(input) {
  if (!input || typeof input !== 'object') {
    return {
      workerOptions: {},
      runnerTargetingOptions: {}
    };
  }

  return {
    workerOptions: pickWorkerOptions(input),
    runnerTargetingOptions: pickRunnerTargetingOptions(input)
  };
}

function splitWorkflowAndWorkerOptions(input) {
  const workerOptions = pickWorkerOptions(input);
  const workflowInput = { ...input };

  for (const key of Object.keys(workerOptions)) {
    delete workflowInput[key];
  }

  return { workflowInput, workerOptions };
}

function pickWorkerOptions(input) {
  const keys = [
    'workerCount',
    'poolId',
    'runnerIdPrefix',
    'resolveWorkerAdapter',
    'adapters',
    'maxTaskRuns',
    'stopOnBlocked'
  ];
  const output = {};

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      output[key] = input[key];
    }
  }

  return output;
}

function pickRunnerTargetingOptions(input) {
  const keys = [
    'taskId',
    'ownerAgentId',
    'preferredRole',
    'assignmentStatus',
    'runnerId',
    'agentIdentity',
    'adapter'
  ];
  const output = {};

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      output[key] = input[key];
    }
  }

  return output;
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

function normalizeMaxSteps(value) {
  if (value == null) {
    return DEFAULT_MAX_STEPS;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('maxSteps must be a positive number.');
  }

  return Math.floor(number);
}

function normalizeWorkerCount(value) {
  if (value == null) {
    return 1;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('workerCount must be a positive number.');
  }

  return Math.floor(number);
}

