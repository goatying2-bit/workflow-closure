import fs from 'node:fs/promises';
import { createChainStageSourceRef } from '../internal.js';
import {
  createAgentContextSystem,
  createAgentMemorySystem,
  createAgentWorkflowChain,
  createVerifier
} from '../index.js';
import { closeDb } from '../storage/db.js';
import { markTestPlan, prepareTestDb } from './helpers/test-db.js';

const dbPath = await prepareTestDb('workflow-chain-smoke-test');

async function main() {

  const memorySystem = await createAgentMemorySystem({ dbPath });
  const contextSystem = await createAgentContextSystem({ dbPath });
  const memoryOptions = {
    system: memorySystem,
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'workflow-chain-smoke-test',
    limit: 5
  };
  const contextOptions = {
    system: contextSystem,
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'workflow-chain-smoke-test',
    limit: 6
  };

  const seededRecall = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: '串联阶段记忆',
    summary: '第二阶段任务与恢复重试应命中 recall',
    content: [
      '输出结论。确认调研范围。明确“输出结论”的对象、边界和输出要求。基于上一阶段输出最终结论。上游阶段交接信息。准备分析。',
      '第二阶段。梳理现有结构。识别“第二阶段”当前实现的边界、耦合点和重复逻辑。第二阶段需要先阻塞再恢复。上游阶段交接信息。第一阶段。',
      '最近错误: 等待恢复：梳理现有结构。第二阶段需要先阻塞再恢复。梳理现有结构。识别“第二阶段”当前实现的边界、耦合点和重复逻辑。'
    ].join('\n'),
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'workflow-chain-smoke-test',
    tags: ['chain', 'stage'],
    sourceKind: 'smoke-test',
    sourceRef: 'workflow-chain-smoke-test:seed'
  });

  const happyPrompts = [];
  const happyChain = await createAgentWorkflowChain({
    dbPath,
    workflowHygieneMetadata: {
      dataClass: 'test',
      retention: 'ephemeral',
      generatedBy: 'workflow-chain-smoke-test'
    },
    memory: memoryOptions,
    context: contextOptions,
    runnerId: 'chain-happy',
    adapter: async ({ task, prompt, recalledMemories, contextSnapshot, contextItems }) => {
      happyPrompts.push(prompt);
      return {
        status: 'done',
        doneSummary: `阶段任务完成：${task.title}`,
        payload: {
          taskId: task.taskId,
          promptHasMemorySection: prompt.includes('相关记忆：'),
          promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
          recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
          contextSnapshotId: contextSnapshot?.snapshotId || null,
          contextItemKinds: contextItems.map((item) => item.kind)
        }
      };
    },
    verifier: createVerifier(async ({ workflow, task, result, state }) => ({
      status: 'passed',
      payload: {
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        adapterStatus: result.status,
        taskCount: state.tasks.length
      }
    }))
  });

  const createdHappy = happyChain.createChain({
    instruction: '完成顺序串联 happy path',
    stages: [
      {
        title: '准备分析',
        instruction: '先完成第一阶段准备工作'
      },
      {
        title: '输出结论',
        instruction: '基于上一阶段输出最终结论'
      }
    ]
  });

  const happyResult = await happyChain.runChain({
    chainId: createdHappy.chain.chainId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });

  assert(happyResult.status === 'done', 'runChain should finish all stages on the happy path');
  assert(happyResult.chain.status === 'done', 'chain should be done after happy path');
  assert(happyResult.state.stages.every((stage) => stage.status === 'done'), 'all stages should be done after happy path');
  assert(happyResult.state.stages.every((stage) => stage.workflowId), 'each stage should have its own workflowId');
  assert(happyResult.steps.length === 2, 'happy path should record one step per stage');
  assert(happyPrompts.some((prompt) => prompt.includes('上游阶段交接信息：')), 'downstream stage prompt should include handoff context');
  assert(happyPrompts.some((prompt) => prompt.includes('准备分析')), 'handoff should mention previous stage title');
  assert(happyPrompts.some((prompt) => prompt.includes('相关记忆：')), 'chain task prompts should include related memory when recall matches');
  assert(!happyPrompts.some((prompt) => prompt.includes('相关上下文：')), 'chain task prompts should omit the broad context heading');

  const happyDoneStep = happyResult.steps.find((step) => step.status === 'done');
  const happyWorkflowDoneStep = happyDoneStep?.workflowResult?.steps?.find((step) => step.status === 'done');
  const happyWorkflowDoneTask = happyDoneStep?.workflowResult?.state?.tasks?.find((task) => task.status === 'done');
  const happyWorkflowCompletionLog = happyDoneStep?.workflowResult?.state
    ? findTaskRunLog(happyDoneStep.workflowResult.state.runLogs, happyWorkflowDoneTask?.taskId, 'task_completed_by_runner')
    : null;
  const happyAdapterPayload = happyWorkflowDoneStep?.adapterPayload;
  assert(happyAdapterPayload?.promptHasMemorySection === true, 'happy path adapter payload should confirm related memory prompt injection');
  assert(happyAdapterPayload?.promptHasContextSection === false, 'happy path adapter payload should confirm no extra context section on happy path');
  assert(Array.isArray(happyWorkflowDoneStep?.memoryContext?.items) && happyWorkflowDoneStep.memoryContext.items.some((item) => item.memoryId === seededRecall.memory.memoryId), 'happy path should recall the related seeded memory');
  assert(happyAdapterPayload?.recalledMemoryIds.includes(seededRecall.memory.memoryId), 'happy path adapter payload should expose recalled related memory ids');
  assert(happyAdapterPayload?.contextItemKinds.includes('current-task'), 'happy path should pass current-task context to adapter');
  assert(happyWorkflowDoneStep?.verification?.status === 'passed', 'happy chain workflow step should expose verifier result');
  assert(happyWorkflowCompletionLog?.payload?.verification?.status === 'passed', 'happy chain workflow run log should persist verifier result');
  assert(happyWorkflowCompletionLog?.payload?.verification?.payload?.byName?.custom?.payload?.adapterStatus === 'done', 'happy chain workflow run log should persist custom verifier payload');

  const happyDoneStage = happyResult.state.stages.find((stage) => stage.title === '输出结论');
  const happyStageSourceRef = createChainStageSourceRef(happyResult.chain.chainId, happyDoneStage.stageId);
  const happyStageMemory = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sourceKind: 'chain-stage',
    sourceRef: happyStageSourceRef,
    graph: false,
    limit: 1
  });
  const happyStageContext = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    chainId: happyResult.chain.chainId,
    stageId: happyDoneStage.stageId,
    sourceKind: 'chain-stage',
    sourceRef: happyStageSourceRef,
    limit: 1
  });
  assert(happyStageMemory.total === 1, 'completed chain stage should upsert one lifecycle memory');
  assert(happyStageMemory.items[0].summary.includes('已完成'), 'completed chain stage memory should store the done summary');
  assert(happyStageContext.total === 1, 'completed chain stage should upsert one lifecycle context item');
  assert(happyStageContext.items[0].summary.includes('已完成'), 'completed chain stage context should store the done summary');
  assert(happyStageContext.items[0].metadata.kind === 'done', 'completed chain stage context should record done metadata');

  let shouldBlock = true;
  const blockedPrompts = [];
  const blockedChain = await createAgentWorkflowChain({
    dbPath,
    workflowHygieneMetadata: {
      dataClass: 'test',
      retention: 'ephemeral',
      generatedBy: 'workflow-chain-smoke-test'
    },
    memory: memoryOptions,
    context: contextOptions,
    runnerId: 'chain-blocked',
    adapter: async ({ workflow, task, prompt, recalledMemories, contextSnapshot, contextItems }) => {
      blockedPrompts.push(prompt);

      if (workflow.instruction.includes('第二阶段') && shouldBlock) {
        return {
          status: 'blocked',
          blockedReason: `等待恢复：${task.title}`,
          payload: {
            taskId: task.taskId,
            promptHasMemorySection: prompt.includes('相关记忆：'),
            promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
            recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
            contextSnapshotId: contextSnapshot?.snapshotId || null,
            contextItemKinds: contextItems.map((item) => item.kind)
          }
        };
      }

      return {
        status: 'done',
        doneSummary: `恢复后完成：${task.title}`,
        payload: {
          taskId: task.taskId,
          promptHasMemorySection: prompt.includes('相关记忆：'),
          promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
          recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
          contextSnapshotId: contextSnapshot?.snapshotId || null,
          contextItemKinds: contextItems.map((item) => item.kind)
        }
      };
    }
  });

  const createdBlocked = blockedChain.createChain({
    instruction: '完成带阻塞恢复的顺序串联',
    stages: [
      {
        title: '第一阶段',
        instruction: '先完成第一阶段'
      },
      {
        title: '第二阶段',
        instruction: '第二阶段需要先阻塞再恢复'
      }
    ]
  });

  const blockedResult = await blockedChain.runChain({
    chainId: createdBlocked.chain.chainId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });

  assert(blockedResult.status === 'blocked', 'runChain should stop when a stage blocks');
  assert(blockedResult.chain.status === 'blocked', 'chain should be blocked when a stage blocks');
  assert(blockedResult.stage?.status === 'blocked', 'current stage should be blocked');

  const blockedStage = blockedResult.state.stages.find((stage) => stage.status === 'blocked');
  assert(blockedStage, 'blocked chain should contain a blocked stage');
  assert(blockedStage.workflowId, 'blocked stage should retain its workflowId');

  const blockedWorkflowState = blockedChain.getChainState({
    chainId: createdBlocked.chain.chainId,
    includeWorkflowStates: true
  });
  const blockedTask = blockedWorkflowState.workflowStates[blockedStage.stageId].tasks.find((task) => task.status === 'blocked');
  assert(blockedTask, 'blocked stage workflow should contain a blocked task');
  assert(blockedWorkflowState.runLogs.some((log) => log.action === 'chain_stage_started_blocked' || log.action === 'chain_stage_workflow_blocked'), 'blocked stage log should exist');
  assert(blockedPrompts.some((prompt) => prompt.includes('相关记忆：')), 'blocked stage prompt should include related recalled memory when recall matches');
  assert(!blockedPrompts.some((prompt) => prompt.includes('相关上下文：')), 'blocked stage prompt should omit the broad context heading');

  const blockedStageSourceRef = createChainStageSourceRef(blockedResult.chain.chainId, blockedStage.stageId);
  const blockedStageMemory = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sourceKind: 'chain-stage',
    sourceRef: blockedStageSourceRef,
    graph: false,
    limit: 1
  });
  const blockedStageContext = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    chainId: blockedResult.chain.chainId,
    stageId: blockedStage.stageId,
    sourceKind: 'chain-stage',
    sourceRef: blockedStageSourceRef,
    limit: 1
  });
  assert(blockedStageMemory.total === 1, 'blocked chain stage should create one lifecycle memory');
  assert(blockedStageMemory.items[0].summary.includes('等待恢复'), 'blocked chain stage memory should record the blocked reason');
  assert(blockedStageContext.total === 1, 'blocked chain stage should create one lifecycle context item');
  assert(blockedStageContext.items[0].summary.includes('等待恢复'), 'blocked chain stage context should record the blocked reason');
  assert(blockedStageContext.items[0].metadata.kind === 'blocked', 'blocked chain stage context should record blocked metadata');

  const resumed = await blockedChain.resumeChainStage({
    chainId: createdBlocked.chain.chainId,
    stageId: blockedStage.stageId,
    taskId: blockedTask.taskId,
    payload: { operator: 'smoke-test' },
    message: '恢复第二阶段'
  });

  assert(resumed.stage.status === 'ready', 'resumeChainStage should move the stage back to ready');
  assert(resumed.task.status === 'ready', 'resumeChainStage should move the workflow task back to ready');

  const resumedStageMemory = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sourceKind: 'chain-stage',
    sourceRef: blockedStageSourceRef,
    graph: false,
    limit: 1
  });
  const resumedStageContext = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    chainId: blockedResult.chain.chainId,
    stageId: blockedStage.stageId,
    sourceKind: 'chain-stage',
    sourceRef: blockedStageSourceRef,
    limit: 1
  });
  assert(resumedStageMemory.total === 1, 'resumeChainStage should update the same stage lifecycle memory');
  assert(resumedStageMemory.items[0].summary.includes('resumed and is ready to continue'), 'resumeChainStage should update stage lifecycle memory to resumed state');
  assert(resumedStageContext.total === 1, 'resumeChainStage should update the same stage lifecycle context');
  assert(resumedStageContext.items[0].summary.includes('resumed and is ready to continue'), 'resumeChainStage should update stage lifecycle context to resumed state');
  assert(resumedStageContext.items[0].metadata.kind === 'resumed', 'resumeChainStage should record resumed metadata');
  assert(resumedStageContext.items[0].metadata.resumedTaskId === blockedTask.taskId, 'resumeChainStage should record resumed task id');
  assert(resumedStageContext.items[0].metadata.resumePayload.operator === 'smoke-test', 'resumeChainStage should persist resume payload');
  assert(resumedStageContext.items[0].content.includes('resumeMessage: 恢复第二阶段'), 'resumeChainStage context should record resume message');

  shouldBlock = false;
  const resumedResult = await blockedChain.runChain({
    chainId: createdBlocked.chain.chainId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });

  assert(resumedResult.status === 'done', 'runChain should finish after resuming the blocked stage');
  assert(resumedResult.chain.status === 'done', 'resumed chain should become done');
  assert(resumedResult.state.stages.every((stage) => stage.status === 'done'), 'all stages should be done after resume');
  assert(resumedResult.state.runLogs.some((log) => log.action === 'chain_stage_resumed'), 'resumeChainStage should write a chain_stage_resumed log');
  assert(blockedPrompts.some((prompt) => prompt.includes(`最近错误: ${blockedTask.lastError}`)), 'retried prompt should preserve the previous task error context');
  assert(blockedPrompts.some((prompt) => prompt.includes('上游阶段交接信息：')), 'retried prompt should keep stage handoff context');

  const resumedStep = resumedResult.steps.find((step) => step.workflowResult?.steps?.some((workflowStep) => workflowStep.prompt?.includes(`最近错误: ${blockedTask.lastError}`)));
  const resumedWorkflowStep = resumedStep?.workflowResult?.steps?.find((workflowStep) => workflowStep.prompt?.includes(`最近错误: ${blockedTask.lastError}`));
  assert(resumedWorkflowStep?.task?.taskId === blockedTask.taskId, 'retried stage should execute the previously blocked workflow task');
  assert(resumedStep?.workflowResult?.steps?.some((workflowStep) => workflowStep?.task?.taskId === blockedTask.taskId), 'retried stage workflow should include the resumed task id');
  assert(resumedWorkflowStep?.adapterPayload?.promptHasContextSection === true, 'retried stage adapter payload should confirm context prompt injection');
  assert(resumedWorkflowStep?.adapterPayload?.contextItemKinds.includes('current-task'), 'retried stage adapter should receive current-task context');

  const completedBlockedStageMemory = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sourceKind: 'chain-stage',
    sourceRef: blockedStageSourceRef,
    graph: false,
    limit: 1
  });
  const completedBlockedStageContext = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    chainId: blockedResult.chain.chainId,
    stageId: blockedStage.stageId,
    sourceKind: 'chain-stage',
    sourceRef: blockedStageSourceRef,
    limit: 1
  });
  assert(completedBlockedStageMemory.total === 1, 'completed resumed stage should still map to one lifecycle memory');
  assert(completedBlockedStageMemory.items[0].summary.includes('已完成'), 'completed resumed stage memory should store the final done summary');
  assert(completedBlockedStageContext.total === 1, 'completed resumed stage should still map to one lifecycle context item');
  assert(completedBlockedStageContext.items[0].summary.includes('已完成'), 'completed resumed stage context should store the final done summary');
  assert(completedBlockedStageContext.items[0].metadata.kind === 'done', 'completed resumed stage context should update metadata to done');

  const rerunPrompts = [];
  const rerunChain = await createAgentWorkflowChain({
    dbPath,
    workflowHygieneMetadata: {
      dataClass: 'test',
      retention: 'ephemeral',
      generatedBy: 'workflow-chain-smoke-test'
    },
    memory: memoryOptions,
    context: contextOptions,
    runnerId: 'chain-rerun',
    adapter: async ({ task, prompt, recalledMemories, contextSnapshot, contextItems }) => {
      rerunPrompts.push(prompt);
      return {
        status: 'done',
        doneSummary: `重跑后完成：${task.title}`,
        payload: {
          taskId: task.taskId,
          promptHasMemorySection: prompt.includes('相关记忆：'),
          promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
          recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
          contextSnapshotId: contextSnapshot?.snapshotId || null,
          contextItemKinds: contextItems.map((item) => item.kind)
        }
      };
    }
  });

  const createdRerun = rerunChain.createChain({
    instruction: '完成带重跑的顺序串联',
    stages: [
      {
        title: '第一阶段',
        instruction: '先完成第一阶段'
      },
      {
        title: '第二阶段',
        instruction: '第二阶段需要在纠正上游错误后重新产出结果',
        plan: markTestPlan({
          goal: '第二阶段需要在纠正上游错误后重新产出结果',
          steps: [
            {
              key: 'collect-facts',
              title: '收集可信事实',
              description: '先产出上游可信事实'
            },
            {
              key: 'rewrite-conclusion',
              title: '改写错误结论',
              description: '修正语义上错误的中间结论'
            },
            {
              key: 'publish-result',
              title: '重新输出结果',
              description: '基于修正后的结论重新产出最终结果'
            }
          ],
          dependencies: [
            { from: 'collect-facts', to: 'rewrite-conclusion' },
            { from: 'rewrite-conclusion', to: 'publish-result' }
          ]
        }, 'workflow-chain-smoke-test')
      }
    ]
  });

  const rerunInitialResult = await rerunChain.runChain({
    chainId: createdRerun.chain.chainId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });

  assert(rerunInitialResult.status === 'done', 'rerun chain fixture should finish before restartChainFromStage');
  const rerunStage = rerunInitialResult.state.stages.find((stage) => stage.title === '第二阶段');
  assert(rerunStage?.workflowId, 'rerun chain fixture should produce a workflow for the rerun stage');

  const rerunWorkflowStateBeforeRestart = rerunChain.getChainState({
    chainId: createdRerun.chain.chainId,
    includeWorkflowStates: true
  });
  const rerunOriginTask = rerunWorkflowStateBeforeRestart.workflowStates[rerunStage.stageId].tasks.find((task) => task.title === '改写错误结论');
  assert(rerunOriginTask, 'rerun chain fixture should contain the rerun origin task');

  const rerunReason = '第二阶段引用了错误上游事实，chain 需要从错误起点重跑';
  const restartedChain = await rerunChain.restartChainFromStage({
    chainId: createdRerun.chain.chainId,
    stageId: rerunStage.stageId,
    taskId: rerunOriginTask.taskId,
    reason: rerunReason,
    fingerprint: 'chain-rerun-smoke',
    operator: 'smoke-test',
    payload: { operator: 'smoke-test', mode: 'rerun' },
    maxSameFingerprintReruns: 2
  });

  assert(restartedChain.stage.status === 'ready', 'restartChainFromStage should move the stage back to ready');
  assert(restartedChain.task?.status === 'ready', 'restartChainFromStage should move the workflow origin task back to ready');
  assert(restartedChain.rerun?.rerunId, 'restartChainFromStage should return a chain rerun record');

  const rerunStageSourceRef = createChainStageSourceRef(createdRerun.chain.chainId, rerunStage.stageId);
  const rerunStageMemory = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sourceKind: 'chain-stage',
    sourceRef: rerunStageSourceRef,
    graph: false,
    limit: 1
  });
  const rerunStageContext = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    chainId: createdRerun.chain.chainId,
    stageId: rerunStage.stageId,
    sourceKind: 'chain-stage',
    sourceRef: rerunStageSourceRef,
    limit: 1
  });
  assert(rerunStageMemory.total === 1, 'rerun stage should still map to one lifecycle memory');
  assert(rerunStageMemory.items[0].summary.includes('restarted from rerun origin'), 'rerun stage memory should store rerun summary');
  assert(rerunStageContext.total === 1, 'rerun stage should still map to one lifecycle context item');
  assert(rerunStageContext.items[0].metadata.kind === 'rerun', 'rerun stage context should record rerun metadata');
  assert(rerunStageContext.items[0].metadata.rerunReason === rerunReason, 'rerun stage context should persist rerun reason');

  const rerunResult = await rerunChain.runChain({
    chainId: createdRerun.chain.chainId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });

  assert(rerunResult.status === 'done', 'runChain should finish after restartChainFromStage');
  assert(rerunResult.chain.status === 'done', 'rerun chain should become done again');
  assert(rerunPrompts.some((prompt) => prompt.includes('上游阶段交接信息：')), 'rerun chain should preserve stage handoff context');

  const rerunChainStep = rerunResult.steps.find((step) => step.workflowResult?.steps?.some((workflowStep) => workflowStep.contextSnapshot?.metadata?.hasRerunHint === true));
  const rerunWorkflowStep = rerunChainStep?.workflowResult?.steps?.find((workflowStep) => workflowStep.contextSnapshot?.metadata?.hasRerunHint === true);
  assert(rerunWorkflowStep, 'rerun chain should expose a workflow step with rerun hint metadata');
  assert(rerunWorkflowStep.prompt.includes('恢复信息：'), 'rerun chain workflow step should render the rerun hint section');
  assert(rerunWorkflowStep.prompt.includes(rerunReason), 'rerun chain workflow step should include rerun reason');
  assert(rerunWorkflowStep.contextSnapshot?.metadata?.selectedReasons.includes('rerun-reason'), 'rerun chain snapshot metadata should record rerun reason selection');
  assert(rerunWorkflowStep.contextItems.some((item) => item.kind === 'rerun-hint'), 'rerun chain workflow step should expose rerun-hint item');
  assert(rerunWorkflowStep.adapterPayload?.promptHasContextSection === true, 'rerun chain adapter payload should confirm context prompt injection');

  const inspected = blockedChain.getChainState({
    chainId: createdBlocked.chain.chainId,
    includeWorkflowStates: true
  });

  assert(inspected.chain.status === 'done', 'getChainState should return the latest chain status');
  assert(inspected.stages.length === 2, 'getChainState should return all stages');
  assert(inspected.runLogs.length > 0, 'getChainState should return chain run logs');
  assert(Object.keys(inspected.workflowStates).length === 2, 'getChainState should include workflow states when requested');

  console.log('workflow-chain smoke test passed');
  console.log(JSON.stringify({
    happyChainId: happyResult.chain.chainId,
    happyStageCount: happyResult.state.stages.length,
    blockedChainId: blockedResult.chain.chainId,
    resumedStageId: resumed.stage.stageId,
    blockedStageWorkflowId: blockedStage.workflowId,
    resumedStepCount: resumedResult.steps.length
  }, null, 2));
}

function findTaskRunLog(runLogs, taskId, action) {
  return Array.isArray(runLogs)
    ? [...runLogs].reverse().find((log) => log.taskId === taskId && log.action === action) || null
    : null;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  closeDb();
});
