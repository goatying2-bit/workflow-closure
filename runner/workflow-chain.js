import { createWorkflowEngine } from '../core/workflow-engine.js';
import { mergeWorkflowHygieneMetadata } from '../storage/data-hygiene.js';
import { initializeChainStore, getChainStore } from '../storage/chains.js';
import {
  resolveAgentMemorySystem,
  resolveMemoryIntegrationContext,
  upsertMemoryBySource,
  createChainStageSourceRef
} from './memory-system.js';
import {
  resolveAgentContextSystem,
  resolveContextIntegrationContext,
  upsertContextItemBySource
} from './context-system.js';
import { createAgentWorkflowWrapper } from './workflow-wrapper.js';

const DEFAULT_MAX_STAGES = 50;
const DEFAULT_MAX_WORKFLOW_STEPS = 100;
const CHAIN_STAGE_SOURCE_KIND = 'chain-stage';
const CHAIN_STAGE_CONTEXT_KIND = 'chain-stage-lifecycle';

export async function createAgentWorkflowChain(options = {}) {
  await initializeChainStore(options);
  const store = getChainStore(options);
  const engine = options.engine || await createWorkflowEngine(options);
  const workflowHygieneMetadata = normalizeWorkflowHygieneMetadata(options.workflowHygieneMetadata);
  const memorySystem = await resolveAgentMemorySystem(options);
  const memoryContext = resolveMemoryIntegrationContext(options);
  const contextSystem = await resolveAgentContextSystem(options);
  const contextContext = resolveContextIntegrationContext(options);
  const wrapper = await createAgentWorkflowWrapper({
    ...options,
    engine,
    memorySystem,
    contextSystem
  });

  return {
    createChain(input = {}) {
      const created = store.createChain({
        chainId: input.chainId,
        instruction: normalizeRequiredText(input.instruction, 'Chain instruction'),
        stages: normalizeStages(input.stages)
      });

      return {
        chain: created.chain,
        state: created,
        stage: created.nextStage,
        nextStage: created.nextStage
      };
    },
    async runChain(input = {}) {
      const chainId = normalizeRequiredText(input.chainId, 'Chain id');
      const maxStages = normalizePositiveInteger(input.maxStages, DEFAULT_MAX_STAGES, 'maxStages');
      const maxWorkflowSteps = normalizePositiveInteger(input.maxWorkflowSteps, DEFAULT_MAX_WORKFLOW_STEPS, 'maxWorkflowSteps');
      return runChainLoop({ store, wrapper, engine, memorySystem, memoryContext, contextSystem, contextContext, workflowHygieneMetadata, chainId, maxStages, maxWorkflowSteps });
    },
    async runNextStage(input = {}) {
      const chainId = normalizeRequiredText(input.chainId, 'Chain id');
      const taskId = normalizeOptionalText(input.taskId);
      const maxWorkflowSteps = normalizePositiveInteger(input.maxWorkflowSteps, DEFAULT_MAX_WORKFLOW_STEPS, 'maxWorkflowSteps');
      return runSingleChainStage({ store, wrapper, engine, memorySystem, memoryContext, contextSystem, contextContext, workflowHygieneMetadata, chainId, taskId, maxWorkflowSteps });
    },
    async resumeChainStage(input = {}) {
      const chainId = normalizeRequiredText(input.chainId, 'Chain id');
      const stageId = normalizeRequiredText(input.stageId, 'Stage id');
      const taskId = normalizeRequiredText(input.taskId, 'Task id');
      const state = store.getChainState(chainId, { includeRunLogs: false });
      const stage = state.stages.find((item) => item.stageId === stageId);

      if (!stage) {
        throw new Error(`Stage not found in chain: ${stageId}`);
      }

      if (stage.status !== 'blocked') {
        throw new Error('Only blocked stages can be resumed.');
      }

      if (!stage.workflowId) {
        throw new Error('Blocked stage is missing workflowId.');
      }

      const resumedTask = await wrapper.resumeTask({
        workflowId: stage.workflowId,
        taskId,
        payload: input.payload,
        message: input.message
      });

      const advanced = store.advanceChainStage({
        chainId,
        stageId,
        status: 'ready',
        workflowId: stage.workflowId,
        blockedReason: null,
        action: 'chain_stage_resumed',
        message: normalizeOptionalText(input.message) || `Resumed blocked stage "${stage.title}".`,
        payload: {
          resumedTaskId: taskId,
          resumePayload: input.payload ?? null,
          workflowId: stage.workflowId
        }
      });

      writeStageMemory(memorySystem, memoryContext, state.chain, advanced.stage, {
        kind: 'resumed',
        message: normalizeOptionalText(input.message),
        resumedTaskId: taskId,
        payload: input.payload,
        previousStage: stage
      });
      writeStageContext(contextSystem, contextContext, state.chain, advanced.stage, {
        kind: 'resumed',
        message: normalizeOptionalText(input.message),
        resumedTaskId: taskId,
        payload: input.payload,
        previousStage: stage
      });

      return {
        stage: advanced.stage,
        chain: advanced.chain,
        nextStage: advanced.nextStage,
        workflow: resumedTask.workflow,
        task: resumedTask.task,
        state: store.getChainState(chainId)
      };
    },
    async restartChainFromStage(input = {}) {
      const chainId = normalizeRequiredText(input.chainId, 'Chain id');
      const stageId = normalizeRequiredText(input.stageId, 'Stage id');
      const reason = normalizeRequiredText(input.reason, 'Rerun reason');
      const fingerprint = normalizeOptionalText(input.fingerprint);
      const operator = normalizeOptionalText(input.operator);
      const payload = input.payload ?? null;
      const state = store.getChainState(chainId, { includeRunLogs: false });
      const stage = state.stages.find((item) => item.stageId === stageId);

      if (!stage) {
        throw new Error(`Stage not found in chain: ${stageId}`);
      }

      let workflowRestart = null;
      let originTaskId = normalizeOptionalText(input.originTaskId || input.taskId);

      if (stage.workflowId) {
        const workflowState = await wrapper.getWorkflowState({ workflowId: stage.workflowId });
        const originTask = resolveOriginWorkflowTask(workflowState, originTaskId);
        originTaskId = originTask.taskId;
        workflowRestart = await wrapper.restartFromTask({
          workflowId: stage.workflowId,
          taskId: originTask.taskId,
          reason,
          fingerprint,
          operator,
          payload,
          maxSameFingerprintReruns: input.maxSameFingerprintReruns
        });
      }

      const restarted = store.restartChainFromStage({
        chainId,
        stageId,
        reason,
        fingerprint,
        operator,
        payload,
        originTaskId,
        maxSameFingerprintReruns: input.maxSameFingerprintReruns
      });

      writeStageMemory(memorySystem, memoryContext, state.chain, restarted.stage, {
        kind: 'rerun',
        rerun: restarted.rerun,
        payload,
        previousStage: stage,
        workflowRestart
      });
      writeStageContext(contextSystem, contextContext, state.chain, restarted.stage, {
        kind: 'rerun',
        rerun: restarted.rerun,
        payload,
        previousStage: stage,
        workflowRestart
      });

      return {
        stage: restarted.stage,
        chain: restarted.chain,
        nextStage: restarted.nextStage,
        rerun: restarted.rerun,
        descendants: restarted.descendants,
        workflow: workflowRestart?.workflow || null,
        task: workflowRestart?.task || null,
        workflowRestart,
        state: store.getChainState(chainId)
      };
    },
    getChainState(input = {}) {
      const chainId = normalizeRequiredText(input.chainId, 'Chain id');
      const state = store.getChainState(chainId, input.query || {});

      if (input.includeWorkflowStates) {
        return {
          ...state,
          workflowStates: buildWorkflowStates(wrapper, state.stages)
        };
      }

      return state;
    }
  };
}

async function runChainLoop({ store, wrapper, engine, memorySystem, memoryContext, contextSystem, contextContext, workflowHygieneMetadata, chainId, maxStages, maxWorkflowSteps }) {
  const steps = [];

  while (steps.length < maxStages) {
    const singleStageResult = await runSingleChainStage({
      store,
      wrapper,
      engine,
      memorySystem,
      memoryContext,
      contextSystem,
      contextContext,
      workflowHygieneMetadata,
      chainId,
      maxWorkflowSteps
    });

    steps.push(...singleStageResult.steps);

    if (singleStageResult.status === 'blocked' || singleStageResult.status === 'idle' || singleStageResult.chain.status === 'done') {
      return buildChainRunResult(
        singleStageResult.state,
        steps,
        singleStageResult.chain.status === 'done' ? 'done' : singleStageResult.status,
        singleStageResult.stage,
        singleStageResult.workflowResult
      );
    }
  }

  return buildChainRunResult(store.getChainState(chainId), steps, 'done', steps[steps.length - 1]?.stage || null, steps[steps.length - 1]?.workflowResult || null);
}

async function runSingleChainStage({ store, wrapper, engine, memorySystem, memoryContext, contextSystem, contextContext, workflowHygieneMetadata, chainId, taskId, maxWorkflowSteps }) {
  const state = store.getChainState(chainId);
  const stage = state.nextStage;

  if (!stage) {
    const status = state.chain.status === 'done' ? 'done' : 'idle';
    return buildChainRunResult(state, [], status, null, null);
  }

  if (stage.status === 'blocked') {
    return buildChainRunResult(state, [], 'blocked', stage, null);
  }

  const stageHandoff = buildStageTaskSeedHandoff(state, stage);
  let workflowResult;

  if (stage.workflowId) {
    workflowResult = await wrapper.runWorkflow({
      workflowId: stage.workflowId,
      taskId,
      maxSteps: maxWorkflowSteps
    });
  } else {
    const created = engine.createWorkflowFromInstruction({
      instruction: buildStageInstruction(state, stage),
      goal: stage.goal || stage.title,
      plan: buildStageWorkflowPlan(stage, stageHandoff, workflowHygieneMetadata)
    });

    workflowResult = await wrapper.runWorkflow({
      workflowId: created.workflow.workflowId,
      taskId,
      maxSteps: maxWorkflowSteps
    });
  }

  const currentWorkflowId = workflowResult.workflow?.workflowId || stage.workflowId || null;

  if (workflowResult.status === 'blocked') {
    const blockedStage = store.advanceChainStage({
      chainId,
      stageId: stage.stageId,
      status: 'blocked',
      workflowId: currentWorkflowId,
      blockedReason: resolveBlockedReason(workflowResult),
      action: stage.workflowId ? 'chain_stage_workflow_blocked' : 'chain_stage_started_blocked',
      message: `Stage "${stage.title}" blocked during workflow execution.`,
      payload: {
        workflowId: currentWorkflowId,
        workflowStatus: workflowResult.workflow?.status || null,
        lastStepStatus: workflowResult.lastStep?.status || null
      }
    });

    writeStageMemory(memorySystem, memoryContext, state.chain, blockedStage.stage, {
      kind: 'blocked',
      workflowResult
    });
    writeStageContext(contextSystem, contextContext, state.chain, blockedStage.stage, {
      kind: 'blocked',
      workflowResult
    });

    return buildChainRunResult(
      store.getChainState(chainId),
      [{ status: 'blocked', stage: blockedStage.stage, workflowResult }],
      'blocked',
      blockedStage.stage,
      workflowResult
    );
  }

  if (workflowResult.status === 'done') {
    const advanced = store.advanceChainStage({
      chainId,
      stageId: stage.stageId,
      status: 'done',
      workflowId: currentWorkflowId,
      doneSummary: resolveStageDoneSummary(stage, workflowResult),
      action: stage.workflowId ? 'chain_stage_workflow_completed' : 'chain_stage_completed',
      message: `Stage "${stage.title}" completed.`,
      payload: {
        workflowId: currentWorkflowId,
        workflowStatus: workflowResult.workflow?.status || null,
        completedTaskCount: workflowResult.state?.tasks?.filter((task) => task.status === 'done').length || 0
      }
    });

    writeStageMemory(memorySystem, memoryContext, state.chain, advanced.stage, {
      kind: 'done',
      workflowResult
    });
    writeStageContext(contextSystem, contextContext, state.chain, advanced.stage, {
      kind: 'done',
      workflowResult
    });

    return buildChainRunResult(
      store.getChainState(chainId),
      [{ status: 'done', stage: advanced.stage, workflowResult }],
      'done',
      advanced.stage,
      workflowResult
    );
  }

  const idleState = stage.workflowId == null
    ? store.advanceChainStage({
        chainId,
        stageId: stage.stageId,
        status: 'doing',
        workflowId: currentWorkflowId,
        action: 'chain_stage_started',
        message: `Stage "${stage.title}" started workflow execution.`,
        payload: {
          workflowId: currentWorkflowId,
          workflowStatus: workflowResult.workflow?.status || null
        }
      })
    : {
        stage: store.getChainStage(chainId, stage.stageId),
        chain: store.getChain(chainId),
        nextStage: store.getNextStage(chainId)
      };

  return buildChainRunResult(
    store.getChainState(chainId),
    [{ status: workflowResult.status, stage: idleState.stage, workflowResult }],
    'idle',
    idleState.stage,
    workflowResult
  );
}


function writeStageMemory(memorySystem, memoryContext, chain, stage, input = {}) {
  if (!memorySystem || !memoryContext.enabled || !chain?.chainId || !stage?.stageId) {
    return null;
  }

  return upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'chainStageLifecycle',
    type: input.kind === 'done' ? 'project' : 'feedback',
    scope: memoryContext.scope,
    title: `Chain stage ${stage.title}`,
    summary: buildStageMemorySummary(stage, input),
    content: buildStageMemoryContent(chain, stage, input),
    projectKey: memoryContext.projectKey,
    workspacePath: memoryContext.workspacePath,
    sessionId: memoryContext.sessionId,
    tags: buildStageMemoryTags(stage, input.kind),
    sourceKind: CHAIN_STAGE_SOURCE_KIND,
    sourceRef: createChainStageSourceRef(chain.chainId, stage.stageId),
    structureJson: {
      chainId: chain.chainId,
      stageId: stage.stageId,
      stageTitle: stage.title,
      kind: input.kind || 'blocked',
      workflowId: stage.workflowId || null,
      stageStatus: stage.status || null,
      doneSummary: stage.doneSummary || null,
      blockedReason: stage.blockedReason || null,
      resumedTaskId: input.resumedTaskId || null,
      resumeMessage: normalizeOptionalText(input.message),
      resumePayload: input.payload ?? null,
      rerunId: input.rerun?.rerunId || null,
      rerunReason: input.rerun?.reason || null,
      rerunFingerprint: input.rerun?.fingerprint || null,
      rerunOperator: input.rerun?.operator || null,
      rerunOriginTaskId: input.rerun?.originTaskId || null,
      rerunPayload: input.rerun?.payload ?? input.payload ?? null,
      rerunDescendantStageIds: extractRerunDescendantStageIds(input.rerun, stage.stageId),
      workflowRestartTaskId: input.workflowRestart?.task?.taskId || null,
      workflowResultStatus: input.workflowResult?.status || null,
      workflowStatus: input.workflowRestart?.workflow?.status || input.workflowResult?.workflow?.status || null,
      previousStageStatus: input.previousStage?.status || null,
      previousWorkflowId: input.previousStage?.workflowId || null
    },
    stability: input.kind === 'done' ? 'stable' : 'volatile',
    confidence: input.kind === 'done' ? 0.9 : 0.8,
    message: buildStageMemoryMessage(stage, input.kind)
  });
}

function writeStageContext(contextSystem, contextContext, chain, stage, input = {}) {
  if (!contextSystem || !contextContext.enabled || !chain?.chainId || !stage?.stageId) {
    return null;
  }

  return upsertContextItemBySource(contextSystem, {
    kind: CHAIN_STAGE_CONTEXT_KIND,
    scope: contextContext.scope,
    title: `Chain stage ${stage.title}`,
    summary: buildStageMemorySummary(stage, input),
    content: buildStageContextContent(chain, stage, input),
    projectKey: contextContext.projectKey,
    workspacePath: contextContext.workspacePath,
    sessionId: contextContext.sessionId,
    workflowId: stage.workflowId || null,
    chainId: chain.chainId,
    stageId: stage.stageId,
    sourceKind: CHAIN_STAGE_SOURCE_KIND,
    sourceRef: createChainStageSourceRef(chain.chainId, stage.stageId),
    metadata: {
      kind: input.kind || null,
      workflowStatus: input.workflowRestart?.workflow?.status || input.workflowResult?.workflow?.status || null,
      workflowResultStatus: input.workflowResult?.status || null,
      resumedTaskId: input.resumedTaskId || null,
      resumePayload: input.payload ?? null,
      rerunId: input.rerun?.rerunId || null,
      rerunReason: input.rerun?.reason || null,
      rerunFingerprint: input.rerun?.fingerprint || null,
      rerunOperator: input.rerun?.operator || null,
      rerunPayload: input.rerun?.payload ?? input.payload ?? null,
      rerunOriginTaskId: input.rerun?.originTaskId || null,
      rerunDescendantStageIds: extractRerunDescendantStageIds(input.rerun, stage.stageId),
      workflowRestartTaskId: input.workflowRestart?.task?.taskId || null,
      previousStageStatus: input.previousStage?.status || null,
      previousWorkflowId: input.previousStage?.workflowId || null
    },
    priority: resolveStageContextPriority(input.kind)
  });
}

function buildStageInstruction(state, stage) {
  const baseInstruction = stage.instruction;
  const chainInstruction = normalizeOptionalText(state.chain?.instruction);
  const previousStages = state.stages.filter((item) => item.sequence < stage.sequence && item.status === 'done');
  const sections = [baseInstruction];

  if (chainInstruction && chainInstruction !== baseInstruction) {
    sections.push('', `链路指令：${chainInstruction}`);
  }

  if (previousStages.length === 0) {
    return sections.join('\n');
  }

  const handoffLines = [];
  for (const previousStage of previousStages) {
    handoffLines.push(`- 阶段: ${previousStage.title}`);
    handoffLines.push(`  完成摘要: ${previousStage.doneSummary || '无'}`);

    const handoff = previousStage.handoff;
    if (handoff && typeof handoff === 'object') {
      if (normalizeOptionalText(handoff.summary)) {
        handoffLines.push(`  交接摘要: ${handoff.summary}`);
      }
      if (Array.isArray(handoff.artifacts) && handoff.artifacts.length > 0) {
        handoffLines.push(`  交接产物: ${handoff.artifacts.join('；')}`);
      }
      if (Array.isArray(handoff.decisions) && handoff.decisions.length > 0) {
        handoffLines.push(`  关键决策: ${handoff.decisions.join('；')}`);
      }
      if (Array.isArray(handoff.openQuestions) && handoff.openQuestions.length > 0) {
        handoffLines.push(`  未决问题: ${handoff.openQuestions.join('；')}`);
      }
      if (Array.isArray(handoff.risks) && handoff.risks.length > 0) {
        handoffLines.push(`  风险: ${handoff.risks.join('；')}`);
      }
      if (normalizeOptionalText(handoff.recommendedNextRole)) {
        handoffLines.push(`  建议下一角色: ${handoff.recommendedNextRole}`);
      }
    }
  }

  return [
    ...sections,
    '',
    '上游阶段交接信息：',
    ...handoffLines
  ].join('\n');
}

function buildStageWorkflowPlan(stage, stageHandoff, workflowHygieneMetadata) {
  if (stage.plan && typeof stage.plan === 'object' && !Array.isArray(stage.plan)) {
    const steps = Array.isArray(stage.plan.steps)
      ? stage.plan.steps.map((step, index) => injectStageHandoffIntoStep(step, index, stageHandoff))
      : [];

    if (steps.length > 0) {
      return mergeStageWorkflowHygieneMetadata({
        ...stage.plan,
        steps
      }, workflowHygieneMetadata);
    }
  }

  return mergeStageWorkflowHygieneMetadata({
    goal: stage.goal || stage.title,
    steps: [injectStageHandoffIntoStep({
      key: 'stage-step-1',
      title: stage.title,
      description: stage.instruction,
      type: inferStageStepType(stage),
      preferredRole: stage.preferredRole,
      requiredCapabilities: stage.requiredCapabilities,
      ownerAgentId: stage.ownerAgentId,
      assignmentStatus: stage.assignmentStatus,
      assignmentReason: stage.assignmentReason
    }, 0, stageHandoff)],
    dependencies: []
  }, workflowHygieneMetadata);
}

function normalizeWorkflowHygieneMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function mergeStageWorkflowHygieneMetadata(plan, workflowHygieneMetadata) {
  return workflowHygieneMetadata ? mergeWorkflowHygieneMetadata(plan, workflowHygieneMetadata) : plan;
}

function injectStageHandoffIntoStep(step, index, stageHandoff) {
  const nextStep = {
    ...step,
    key: step?.key || `stage-step-${index + 1}`,
    title: String(step?.title || '').trim() || `阶段步骤 ${index + 1}`
  };

  if (index !== 0 || !stageHandoff) {
    return nextStep;
  }

  return {
    ...nextStep,
    handoff: mergeStructuredHandoff(nextStep.handoff, stageHandoff)
  };
}

function buildStageTaskSeedHandoff(state, stage) {
  const previousStages = state.stages.filter((item) => item.sequence < stage.sequence && item.status === 'done');
  if (previousStages.length === 0) {
    return null;
  }

  const artifacts = [];
  const decisions = [];
  const openQuestions = [];
  const risks = [];
  const summaryParts = [];

  for (const previousStage of previousStages) {
    const handoff = normalizeStructuredHandoff(previousStage.handoff);
    const stageLabel = previousStage.title || '上游阶段';
    const summary = normalizeOptionalText(handoff?.summary) || normalizeOptionalText(previousStage.doneSummary);

    if (summary) {
      summaryParts.push(`${stageLabel}：${summary}`);
    }

    if (handoff?.artifacts?.length > 0) {
      artifacts.push(...handoff.artifacts.map((item) => `${stageLabel}｜${item}`));
    }

    if (handoff?.decisions?.length > 0) {
      decisions.push(...handoff.decisions.map((item) => `${stageLabel}｜${item}`));
    }

    if (handoff?.openQuestions?.length > 0) {
      openQuestions.push(...handoff.openQuestions.map((item) => `${stageLabel}｜${item}`));
    }

    if (handoff?.risks?.length > 0) {
      risks.push(...handoff.risks.map((item) => `${stageLabel}｜${item}`));
    }
  }

  return normalizeStructuredHandoff({
    summary: summaryParts.join('；'),
    artifacts: dedupeStrings(artifacts),
    decisions: dedupeStrings(decisions),
    openQuestions: dedupeStrings(openQuestions),
    risks: dedupeStrings(risks),
    recommendedNextRole: normalizeOptionalText(stage.preferredRole)
  });
}

function mergeStructuredHandoff(existing, incoming) {
  const previous = normalizeStructuredHandoff(existing);
  const next = normalizeStructuredHandoff(incoming);

  if (!previous) {
    return next;
  }

  if (!next) {
    return previous;
  }

  return normalizeStructuredHandoff({
    summary: normalizeOptionalText(previous.summary) || normalizeOptionalText(next.summary),
    artifacts: dedupeStrings([...previous.artifacts, ...next.artifacts]),
    decisions: dedupeStrings([...previous.decisions, ...next.decisions]),
    openQuestions: dedupeStrings([...previous.openQuestions, ...next.openQuestions]),
    risks: dedupeStrings([...previous.risks, ...next.risks]),
    recommendedNextRole: normalizeOptionalText(previous.recommendedNextRole) || normalizeOptionalText(next.recommendedNextRole)
  });
}

function inferStageStepType(stage) {
  if (normalizeOptionalText(stage.preferredRole) === 'researcher') {
    return 'research';
  }
  if (normalizeOptionalText(stage.preferredRole) === 'implementer') {
    return 'implement';
  }
  if (normalizeOptionalText(stage.preferredRole) === 'verifier' || normalizeOptionalText(stage.preferredRole) === 'reviewer') {
    return 'verify';
  }
  return 'task';
}

function normalizeStructuredHandoff(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const handoff = {
    summary: normalizeOptionalText(value.summary),
    artifacts: normalizeOptionalStringArray(value.artifacts),
    decisions: normalizeOptionalStringArray(value.decisions),
    openQuestions: normalizeOptionalStringArray(value.openQuestions),
    risks: normalizeOptionalStringArray(value.risks),
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

function dedupeStrings(values) {
  return [...new Set(normalizeOptionalStringArray(values))];
}


function resolveBlockedReason(workflowResult) {
  return workflowResult.lastStep?.task?.blockedReason
    || workflowResult.lastStep?.task?.lastError
    || workflowResult.workflow?.blockedReason
    || workflowResult.lastStep?.error
    || 'Stage workflow is blocked.';
}

function resolveStageDoneSummary(stage, workflowResult) {
  const doneTasks = Array.isArray(workflowResult.state?.tasks)
    ? workflowResult.state.tasks.filter((task) => task.status === 'done')
    : [];
  const taskSummaries = doneTasks
    .map((task) => task.doneSummary || task.title)
    .filter(Boolean);

  const summaryLines = [];
  summaryLines.push(`${stage.title} 已完成。`);

  if (taskSummaries.length > 0) {
    summaryLines.push('任务摘要：');
    for (const summary of taskSummaries) {
      summaryLines.push(`- ${summary}`);
    }
  }

  return summaryLines.join('\n');
}

function buildChainRunResult(state, steps, status, stage, workflowResult) {
  return {
    status,
    chain: state.chain,
    state,
    stages: state.stages,
    runLogs: state.runLogs,
    steps,
    stage,
    workflowResult,
    lastStep: steps.length > 0 ? steps[steps.length - 1] : null
  };
}

function buildWorkflowStates(wrapper, stages) {
  const workflowStates = {};

  for (const stage of stages) {
    if (!stage.workflowId) {
      continue;
    }

    workflowStates[stage.stageId] = wrapper.getWorkflowState({ workflowId: stage.workflowId });
  }

  return workflowStates;
}

function resolveOriginWorkflowTask(workflowState, requestedTaskId) {
  const tasks = Array.isArray(workflowState?.tasks) ? workflowState.tasks : [];

  if (tasks.length === 0) {
    throw new Error('Stage workflow has no tasks to restart.');
  }

  if (!requestedTaskId) {
    return tasks[0];
  }

  const task = tasks.find((item) => item.taskId === requestedTaskId);
  if (!task) {
    throw new Error(`Task not found in stage workflow: ${requestedTaskId}`);
  }

  return task;
}

function buildStageMemorySummary(stage, input = {}) {
  if (input.kind === 'done') {
    return stage.doneSummary || `Stage "${stage.title}" completed.`;
  }

  if (input.kind === 'rerun') {
    return `Stage "${stage.title}" restarted from rerun origin and is ready to retry.`;
  }

  if (input.kind === 'resumed') {
    return `Stage "${stage.title}" resumed and is ready to continue.`;
  }

  return stage.blockedReason || `Stage "${stage.title}" is blocked.`;
}

function buildStageMemoryContent(chain, stage, input = {}) {
  const rerunDescendantStageIds = extractRerunDescendantStageIds(input.rerun, stage.stageId);

  return [
    `chainId: ${chain.chainId}`,
    `chainInstruction: ${chain.instruction}`,
    `stageId: ${stage.stageId}`,
    `stageTitle: ${stage.title}`,
    `stageInstruction: ${stage.instruction}`,
    `stageStatus: ${stage.status}`,
    `workflowId: ${stage.workflowId || '无'}`,
    `doneSummary: ${stage.doneSummary || '无'}`,
    `blockedReason: ${stage.blockedReason || '无'}`,
    `resumedTaskId: ${input.resumedTaskId || '无'}`,
    `resumeMessage: ${input.message || '无'}`,
    `resumePayload: ${input.payload == null ? 'null' : JSON.stringify(input.payload)}`,
    `rerunId: ${input.rerun?.rerunId || '无'}`,
    `rerunReason: ${input.rerun?.reason || '无'}`,
    `rerunFingerprint: ${input.rerun?.fingerprint || '无'}`,
    `rerunOperator: ${input.rerun?.operator || '无'}`,
    `rerunOriginTaskId: ${input.rerun?.originTaskId || '无'}`,
    `rerunPayload: ${safeJson(input.rerun?.payload ?? input.payload ?? null)}`,
    `rerunDescendantStageIds: ${rerunDescendantStageIds.length > 0 ? rerunDescendantStageIds.join(', ') : '无'}`,
    `workflowRestartTaskId: ${input.workflowRestart?.task?.taskId || '无'}`,
    `workflowResultStatus: ${input.workflowResult?.status || '无'}`,
    `workflowStatus: ${input.workflowRestart?.workflow?.status || input.workflowResult?.workflow?.status || '无'}`,
    `previousStageStatus: ${input.previousStage?.status || '无'}`,
    `previousWorkflowId: ${input.previousStage?.workflowId || '无'}`
  ].join('\n');
}

function buildStageContextContent(chain, stage, input = {}) {
  const rerunDescendantStageIds = extractRerunDescendantStageIds(input.rerun, stage.stageId);

  return [
    `chainId: ${chain.chainId}`,
    `chainInstruction: ${chain.instruction}`,
    `stageId: ${stage.stageId}`,
    `stageTitle: ${stage.title}`,
    `stageInstruction: ${stage.instruction}`,
    `stageStatus: ${stage.status}`,
    `workflowId: ${stage.workflowId || '无'}`,
    `doneSummary: ${stage.doneSummary || '无'}`,
    `blockedReason: ${stage.blockedReason || '无'}`,
    `resumedTaskId: ${input.resumedTaskId || '无'}`,
    `resumeMessage: ${input.message || '无'}`,
    `resumePayload: ${safeJson(input.payload ?? null)}`,
    `rerunId: ${input.rerun?.rerunId || '无'}`,
    `rerunReason: ${input.rerun?.reason || '无'}`,
    `rerunFingerprint: ${input.rerun?.fingerprint || '无'}`,
    `rerunOperator: ${input.rerun?.operator || '无'}`,
    `rerunOriginTaskId: ${input.rerun?.originTaskId || '无'}`,
    `rerunPayload: ${safeJson(input.rerun?.payload ?? input.payload ?? null)}`,
    `rerunDescendantStageIds: ${rerunDescendantStageIds.length > 0 ? rerunDescendantStageIds.join(', ') : '无'}`,
    `workflowRestartTaskId: ${input.workflowRestart?.task?.taskId || '无'}`,
    `workflowResultStatus: ${input.workflowResult?.status || '无'}`,
    `workflowStatus: ${input.workflowRestart?.workflow?.status || input.workflowResult?.workflow?.status || '无'}`,
    `previousStageStatus: ${input.previousStage?.status || '无'}`,
    `previousWorkflowId: ${input.previousStage?.workflowId || '无'}`
  ].join('\n');
}

function buildStageMemoryTags(stage, kind) {
  const tags = ['chain', 'stage', stage.status];
  if (kind) {
    tags.push(kind);
  }
  return [...new Set(tags)];
}

function extractRerunDescendantStageIds(rerun, stageId) {
  if (!Array.isArray(rerun?.affectedStageIds)) {
    return [];
  }

  return rerun.affectedStageIds.filter((item) => item && item !== stageId);
}

function resolveStageContextPriority(kind) {
  if (kind === 'done') {
    return 70;
  }

  if (kind === 'rerun') {
    return 96;
  }

  if (kind === 'resumed') {
    return 95;
  }

  return 90;
}

function buildStageMemoryMessage(stage, kind) {
  if (kind === 'done') {
    return `Updated chain-stage memory after completing "${stage.title}".`;
  }

  if (kind === 'rerun') {
    return `Updated chain-stage memory after rerunning "${stage.title}".`;
  }

  if (kind === 'resumed') {
    return `Updated chain-stage memory after resuming "${stage.title}".`;
  }

  return `Updated chain-stage memory after blocking "${stage.title}".`;
}


function normalizeStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error('Chain stages are required.');
  }

  return stages.map((stage, index) => {
    if (!stage || typeof stage !== 'object') {
      throw new Error(`Stage at index ${index} must be an object.`);
    }

    return {
      stageId: normalizeOptionalText(stage.stageId),
      title: normalizeRequiredText(stage.title, `Stage title at index ${index}`),
      instruction: normalizeRequiredText(stage.instruction, `Stage instruction at index ${index}`),
      goal: normalizeOptionalText(stage.goal),
      plan: stage.plan ?? null,
      ownerAgentId: normalizeOptionalText(stage.ownerAgentId),
      preferredRole: normalizeOptionalText(stage.preferredRole),
      requiredCapabilities: normalizeOptionalStringArray(stage.requiredCapabilities),
      assignmentStatus: normalizeOptionalText(stage.assignmentStatus),
      assignmentReason: normalizeOptionalText(stage.assignmentReason),
      handoff: normalizeStructuredHandoff(stage.handoff) ?? null
    };
  });
}

function normalizeRequiredText(value, label) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }

  return text;
}

function normalizeOptionalStringArray(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('requiredCapabilities must be an array when provided.');
  }

  return value
    .map((item) => normalizeOptionalText(item))
    .filter(Boolean);
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

function safeJson(value) {
  return value == null ? 'null' : JSON.stringify(value);
}
