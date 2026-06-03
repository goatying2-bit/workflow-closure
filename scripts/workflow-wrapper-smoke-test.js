import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkflowTaskSourceRef } from '../internal.js';
import {
  createAgentContextSystem,
  createAgentMemorySystem,
  createAgentWorkflowWrapper,
  createVerifier,
  createWorkflowEngine
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'workflow-wrapper-smoke-test.db');

async function main() {
  await fs.rm(dbPath, { force: true });

  const memorySystem = await createAgentMemorySystem({ dbPath });
  const contextSystem = await createAgentContextSystem({ dbPath });
  const engine = await createWorkflowEngine({ dbPath });
  const memoryOptions = {
    system: memorySystem,
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'workflow-wrapper-smoke-test',
    limit: 5
  };
  const contextOptions = {
    system: contextSystem,
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'workflow-wrapper-smoke-test',
    limit: 8
  };

  const seededRecall = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: '包装器任务偏好',
    summary: '确认目标与约束或问题复现阶段应命中 recall',
    content: [
      '实现包装器 happy path。确认目标与约束。明确“实现包装器 happy path”的交付结果、输入输出和限制条件。',
      '修复会先阻塞再恢复的工作流。复现并界定问题。确认“修复会先阻塞再恢复的工作流”的触发条件、影响范围和期望行为。',
      '最近错误: 等待恢复：复现并界定问题。修复会先阻塞再恢复的工作流。复现并界定问题。确认“修复会先阻塞再恢复的工作流”的触发条件、影响范围和期望行为。'
    ].join('\n'),
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'workflow-wrapper-smoke-test',
    tags: ['wrapper', 'recall'],
    sourceKind: 'smoke-test',
    sourceRef: 'workflow-wrapper-smoke-test:seed'
  });

  const doneWrapper = await createAgentWorkflowWrapper({
    dbPath,
    memory: memoryOptions,
    context: contextOptions,
    runnerId: 'wrapper-done',
    adapter: async ({ task, prompt, recalledMemories, contextSnapshot, contextItems }) => ({
      status: 'done',
      doneSummary: `包装器自动完成：${task.title}`,
      payload: {
        taskId: task.taskId,
        promptHasMemorySection: prompt.includes('相关记忆：'),
        promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
        recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
        contextSnapshotId: contextSnapshot?.snapshotId || null,
        contextItemKinds: contextItems.map((item) => item.kind)
      }
    }),
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

  const doneResult = await doneWrapper.runInstruction({
    instruction: '实现包装器 happy path',
    maxSteps: 20
  });

  assert(doneResult.status === 'done', 'runInstruction should finish the workflow on the happy path');
  assert(doneResult.workflow.status === 'done', 'workflow should be done after wrapper happy path');
  assert(doneResult.state.tasks.every((task) => task.status === 'done'), 'all tasks should be done after wrapper happy path');
  assert(doneResult.steps.length >= 2, 'wrapper should collect loop steps');
  assert(doneResult.lastStep?.status === 'idle', 'happy path should finish when runner becomes idle');

  const doneTask = doneResult.state.tasks.find((task) => task.status === 'done');
  const doneTaskStep = doneResult.steps.find((step) => step.status === 'done');
  const doneTaskCompletionLog = findTaskRunLog(doneResult.state.runLogs, doneTask.taskId, 'task_completed_by_runner');
  assert(doneTaskStep?.prompt?.includes('相关记忆：'), 'wrapper happy-path prompt should include related memory when recall matches');
  assert(!doneTaskStep?.prompt?.includes('相关上下文：'), 'wrapper happy-path prompt should omit the broad context heading');
  assert(doneTaskStep?.contextSnapshot?.snapshotId, 'wrapper step should expose contextSnapshot');
  assert(doneTaskStep?.contextItems?.some((item) => item.kind === 'current-task'), 'wrapper step should expose current-task context item');
  assert(Array.isArray(doneTaskStep?.memoryContext?.items) && doneTaskStep.memoryContext.items.some((item) => item.memoryId === seededRecall.memory.memoryId), 'wrapper should recall the related seeded memory on happy path');
  assert(doneTaskStep?.adapterPayload?.promptHasMemorySection === true, 'adapter payload should confirm prompt memory injection on happy path');
  assert(doneTaskStep?.adapterPayload?.recalledMemoryIds.includes(seededRecall.memory.memoryId), 'adapter payload should expose recalled related memory ids on happy path');
  assert(doneTaskStep?.adapterPayload?.promptHasContextSection === false, 'adapter payload should confirm no extra context section on happy path');
  assert(doneTaskStep?.verification?.status === 'passed', 'wrapper happy-path step should expose verifier result');
  assert(doneTaskCompletionLog?.payload?.verification?.status === 'passed', 'wrapper happy-path run log should persist verifier result');
  assert(doneTaskCompletionLog?.payload?.verification?.payload?.byName?.custom?.payload?.adapterStatus === 'done', 'wrapper happy-path run log should persist custom verifier payload');

  const doneTaskSourceRef = createWorkflowTaskSourceRef(doneResult.workflow.workflowId, doneTask.taskId);
  const doneTaskRecall = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sourceKind: 'workflow-task',
    sourceRef: doneTaskSourceRef,
    graph: false,
    limit: 1
  });
  const doneTaskContext = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: doneResult.workflow.workflowId,
    taskId: doneTask.taskId,
    sourceKind: 'workflow-task',
    sourceRef: doneTaskSourceRef,
    limit: 1
  });
  const doneTaskSnapshots = contextSystem.querySnapshots({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: doneResult.workflow.workflowId,
    taskId: doneTask.taskId,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: doneTaskSourceRef,
    limit: 20
  });
  assert(doneTaskRecall.total === 1, 'done workflow task should upsert one lifecycle memory');
  assert(doneTaskRecall.items[0].summary.includes('包装器自动完成'), 'done task memory should store the completion summary');
  assert(doneTaskContext.total === 1, 'done workflow task should upsert one lifecycle context item');
  assert(doneTaskContext.items[0].summary.includes('包装器自动完成'), 'done task context should store the completion summary');
  assert(doneTaskSnapshots.total >= 1, 'done workflow task should append at least one context snapshot');
  assert(doneTaskSnapshots.items[0].items.some((item) => item.kind === 'current-task'), 'done workflow snapshot should retain current task context');

  let shouldBlock = true;
  const blockedWrapper = await createAgentWorkflowWrapper({
    dbPath,
    memory: memoryOptions,
    context: contextOptions,
    runnerId: 'wrapper-blocked',
    adapter: async ({ task, prompt, recalledMemories, contextSnapshot, contextItems }) => {
      if (shouldBlock) {
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
          prompt,
          promptHasMemorySection: prompt.includes('相关记忆：'),
          promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
          recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
          contextSnapshotId: contextSnapshot?.snapshotId || null,
          contextItemKinds: contextItems.map((item) => item.kind)
        }
      };
    }
  });

  const blockedResult = await blockedWrapper.runInstruction({
    instruction: '修复会先阻塞再恢复的工作流',
    maxSteps: 20
  });

  assert(blockedResult.status === 'blocked', 'runInstruction should stop when the adapter blocks');
  assert(blockedResult.workflow.status === 'blocked', 'workflow should be blocked after blocked adapter result');
  assert(blockedResult.lastStep?.status === 'blocked', 'last step should reflect blocked status');

  const blockedTask = blockedResult.state.tasks.find((task) => task.status === 'blocked');
  assert(blockedTask, 'blocked workflow should contain a blocked task');
  assert(blockedTask.lastError === blockedTask.blockedReason, 'blocked task should preserve lastError');
  assert(blockedResult.lastStep?.prompt?.includes('相关记忆：'), 'blocked task prompt should include related recalled memory on first attempt when recall matches');
  assert(!blockedResult.lastStep?.prompt?.includes('相关上下文：'), 'blocked task prompt should omit broad context by default');
  assert(blockedResult.lastStep?.contextSnapshot?.snapshotId, 'blocked step should expose contextSnapshot');
  assert(Array.isArray(blockedResult.lastStep?.memoryContext?.items) && blockedResult.lastStep.memoryContext.items.some((item) => item.memoryId === seededRecall.memory.memoryId), 'blocked first attempt should recall the related seeded memory');
  assert(blockedResult.lastStep?.adapterPayload?.promptHasMemorySection === true, 'blocked adapter payload should reflect prompt memory injection on first attempt');
  assert(blockedResult.lastStep?.adapterPayload?.promptHasContextSection === false, 'blocked adapter payload should reflect no extra context section on first attempt');
  assert(blockedResult.lastStep?.adapterPayload?.recalledMemoryIds.includes(seededRecall.memory.memoryId), 'blocked adapter payload should expose recalled related memory ids on first attempt');
  assert(blockedResult.lastStep?.adapterPayload?.contextItemKinds.includes('current-task'), 'blocked adapter payload should receive current-task context');

  const blockedTaskSourceRef = createWorkflowTaskSourceRef(blockedResult.workflow.workflowId, blockedTask.taskId);
  const blockedTaskMemory = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sourceKind: 'workflow-task',
    sourceRef: blockedTaskSourceRef,
    graph: false,
    limit: 1
  });
  const blockedTaskContext = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: blockedResult.workflow.workflowId,
    taskId: blockedTask.taskId,
    sourceKind: 'workflow-task',
    sourceRef: blockedTaskSourceRef,
    limit: 1
  });
  const blockedTaskSnapshots = contextSystem.querySnapshots({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: blockedResult.workflow.workflowId,
    taskId: blockedTask.taskId,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: blockedTaskSourceRef,
    limit: 20
  });
  assert(blockedTaskMemory.total === 1, 'blocked workflow task should create one lifecycle memory');
  assert(blockedTaskMemory.items[0].summary.includes('等待恢复'), 'blocked task memory should record the blocked reason');
  assert(blockedTaskContext.total === 1, 'blocked workflow task should create one lifecycle context item');
  assert(blockedTaskContext.items[0].summary.includes('等待恢复'), 'blocked task context should record the blocked reason');
  assert(blockedTaskContext.items[0].metadata.kind === 'blocked', 'blocked task context should store blocked metadata');
  assert(blockedTaskContext.items[0].metadata.contextSnapshotId === blockedResult.lastStep.contextSnapshot.snapshotId, 'blocked task context should store snapshot id');
  assert(blockedTaskSnapshots.total === 1, 'blocked workflow task should create one task snapshot on first attempt');

  const resumed = blockedWrapper.resumeTask({
    workflowId: blockedResult.workflow.workflowId,
    taskId: blockedTask.taskId,
    payload: { operator: 'smoke-test' },
    message: '恢复阻塞任务'
  });

  assert(resumed.task.status === 'ready', 'resumeTask should move the task back to ready');
  assert(resumed.task.attemptCount === blockedTask.attemptCount, 'resumeTask should preserve historical attemptCount before retrying');
  assert(resumed.task.lastError === blockedTask.lastError, 'resumeTask should keep lastError for the next attempt');
  assert(resumed.task.reasonCode == null, 'resumeTask should clear the stale reasonCode when returning to ready');

  const resumedTaskMemory = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sourceKind: 'workflow-task',
    sourceRef: blockedTaskSourceRef,
    graph: false,
    limit: 1
  });
  const resumedTaskContext = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: blockedResult.workflow.workflowId,
    taskId: blockedTask.taskId,
    sourceKind: 'workflow-task',
    sourceRef: blockedTaskSourceRef,
    limit: 1
  });
  assert(resumedTaskMemory.total === 1, 'resumeTask should update the same lifecycle memory record');
  assert(resumedTaskMemory.items[0].summary.includes('resumed and is ready to retry'), 'resumeTask should update lifecycle memory to resumed state');
  assert(resumedTaskContext.total === 1, 'resumeTask should update the same lifecycle context item');
  assert(resumedTaskContext.items[0].summary.includes('resumed and is ready to retry'), 'resumeTask should update lifecycle context to resumed state');
  assert(resumedTaskContext.items[0].metadata.resumeMessage === '恢复阻塞任务', 'resumeTask should persist normalized resume message in context metadata');
  assert(resumedTaskContext.items[0].metadata.resumePayload.operator === 'smoke-test', 'resumeTask should persist resume payload in context metadata');
  assert(resumedTaskContext.items[0].content.includes('resumeMessage: 恢复阻塞任务'), 'resumeTask context should record resume message');

  shouldBlock = false;
  const resumedRunResult = await blockedWrapper.runWorkflow({
    workflowId: blockedResult.workflow.workflowId,
    maxSteps: 20
  });

  assert(resumedRunResult.status === 'done', 'runWorkflow should finish the resumed workflow');
  assert(resumedRunResult.workflow.status === 'done', 'resumed workflow should become done');
  assert(resumedRunResult.state.tasks.every((task) => task.status === 'done'), 'all tasks should be done after resume flow');

  const retriedStep = resumedRunResult.steps.find((step) => step.prompt && step.prompt.includes(`最近错误: ${blockedTask.lastError}`));
  assert(retriedStep, 'retried prompt should preserve the previous lastError context');
  assert(!retriedStep.prompt.includes('相关上下文：'), 'retried prompt should stay compact and omit the broad context heading');
  assert(retriedStep.prompt.includes('恢复信息：'), 'retried prompt should render the resume hint section');
  assert(retriedStep.contextSnapshot?.metadata?.hasResumeHint === true, 'retried step should record resume hint metadata');
  assert(retriedStep.contextSnapshot?.metadata?.selectedReasons.includes('resume-message'), 'retried step should record why the resume hint was selected');
  assert(retriedStep.contextItems.some((item) => item.kind === 'resume-hint'), 'retried step should expose the resume-hint item');
  assert(retriedStep.adapterPayload?.promptHasMemorySection === true, 'retried adapter payload should confirm memory prompt injection');
  assert(retriedStep.adapterPayload?.promptHasContextSection === true, 'retried adapter payload should confirm context prompt injection');
  assert(retriedStep.adapterPayload?.contextSnapshotId === retriedStep.contextSnapshot.snapshotId, 'retried adapter payload should receive the current snapshot id');
  assert(resumedRunResult.state.runLogs.some((log) => log.action === 'task_resumed'), 'resumeTask should write a task_resumed log');

  const retriedTaskSnapshots = contextSystem.querySnapshots({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: blockedResult.workflow.workflowId,
    taskId: blockedTask.taskId,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: blockedTaskSourceRef,
    limit: 20
  });
  assert(retriedTaskSnapshots.total === 2, 'retry should append another auditable task snapshot');
  assert(retriedTaskSnapshots.items.some((snapshot) => snapshot.content.includes('最近错误 / 阻塞：')), 'retry snapshots should preserve the last-error section');
  assert(retriedTaskSnapshots.items.some((snapshot) => snapshot.content.includes('恢复信息：')), 'retry snapshots should render the resume hint section');
  assert(retriedTaskSnapshots.items.some((snapshot) => snapshot.metadata?.hasResumeHint === true), 'retry snapshots should persist resume hint metadata');
  assert(retriedTaskSnapshots.items.some((snapshot) => snapshot.items.some((item) => item.kind === 'resume-hint')), 'retry snapshots should persist the resume-hint item');

  const rerunWrapper = await createAgentWorkflowWrapper({
    dbPath,
    engine,
    memory: memoryOptions,
    context: contextOptions,
    runnerId: 'wrapper-rerun',
    adapter: async ({ task, prompt, recalledMemories, contextSnapshot, contextItems }) => ({
      status: 'done',
      doneSummary: `包装器纠错重跑完成：${task.title}`,
      payload: {
        taskId: task.taskId,
        prompt,
        promptHasMemorySection: prompt.includes('相关记忆：'),
        promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
        recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
        contextSnapshotId: contextSnapshot?.snapshotId || null,
        contextItemKinds: contextItems.map((item) => item.kind)
      }
    })
  });

  const rerunWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证包装器纠错重跑',
    plan: {
      goal: '验证包装器纠错重跑',
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
    }
  });

  const rerunInitialResult = await rerunWrapper.runWorkflow({
    workflowId: rerunWorkflow.workflow.workflowId,
    maxSteps: 20
  });
  assert(rerunInitialResult.status === 'done', 'rerun fixture workflow should finish before restartFromTask');

  const rerunStateBeforeRestart = engine.getWorkflowState({ workflowId: rerunWorkflow.workflow.workflowId });
  const rerunOriginTask = rerunStateBeforeRestart.tasks.find((task) => task.title === '改写错误结论');
  assert(rerunOriginTask, 'rerun fixture should contain the origin task');

  const rerunDescendantTaskIds = engine.listDescendantTaskIds({
    workflowId: rerunWorkflow.workflow.workflowId,
    taskId: rerunOriginTask.taskId
  });
  assert(rerunDescendantTaskIds.length === 1, 'rerun fixture should have one descendant task from the selected origin');

  const rerunDescendantTaskBeforeRestart = rerunStateBeforeRestart.tasks.find((task) => task.taskId === rerunDescendantTaskIds[0]);
  assert(rerunDescendantTaskBeforeRestart?.status === 'done', 'rerun descendant should be done before restartFromTask');

  const rerunReason = '中间结论引用了错误上游事实，必须从起点重跑';
  const rerunFingerprint = 'wrapper-rerun-smoke';
  const restarted = rerunWrapper.restartFromTask({
    workflowId: rerunWorkflow.workflow.workflowId,
    taskId: rerunOriginTask.taskId,
    reason: rerunReason,
    fingerprint: rerunFingerprint,
    operator: 'smoke-test',
    payload: { operator: 'smoke-test', mode: 'rerun' },
    maxSameFingerprintReruns: 2
  });

  assert(restarted.task.status === 'ready', 'restartFromTask should move the origin task back to ready');
  assert(restarted.task.doneSummary == null, 'restartFromTask should clear the origin doneSummary');
  assert(restarted.task.lastError === rerunReason, 'restartFromTask should persist the rerun reason on the origin task');
  assert(restarted.descendants.length === 1, 'restartFromTask should return the invalidated descendants');
  assert(restarted.descendants[0].taskId === rerunDescendantTaskIds[0], 'restartFromTask should invalidate the expected descendant task');
  assert(restarted.descendants[0].status === 'pending', 'restartFromTask should move descendants back to pending');
  assert(restarted.descendants[0].doneSummary == null, 'restartFromTask should clear descendant doneSummary');
  assert(restarted.descendants[0].lastError.includes(rerunReason), 'restartFromTask should record the rerun reason on descendants');
  assert(restarted.state.runLogs.some((log) => log.action === 'workflow_rerun_created'), 'restartFromTask should write a workflow_rerun_created log');
  assert(restarted.state.runLogs.some((log) => log.action === 'task_invalidated_by_rerun' && log.taskId === rerunDescendantTaskIds[0]), 'restartFromTask should write descendant invalidation logs');

  const rerunAuditRows = engine.listWorkflowReruns({
    workflowId: rerunWorkflow.workflow.workflowId,
    limit: 5
  });
  assert(rerunAuditRows.length === 1, 'restartFromTask should create one workflow rerun audit row');
  assert(rerunAuditRows[0].rerunId === restarted.rerun.rerunId, 'workflow rerun audit should expose the latest rerun id');
  assert(rerunAuditRows[0].originTaskId === rerunOriginTask.taskId, 'workflow rerun audit should store the origin task id');
  assert(rerunAuditRows[0].fingerprint === rerunFingerprint, 'workflow rerun audit should store the rerun fingerprint');
  assert(rerunAuditRows[0].reason === rerunReason, 'workflow rerun audit should store the rerun reason');
  assert(rerunAuditRows[0].affectedTaskCount === 2, 'workflow rerun audit should store the affected task count');
  assert(rerunAuditRows[0].affectedTaskIds.includes(rerunDescendantTaskIds[0]), 'workflow rerun audit should include descendant task ids');

  const rerunRevisions = engine.listTaskRevisions({
    workflowId: rerunWorkflow.workflow.workflowId,
    rerunId: restarted.rerun.rerunId,
    limit: 10
  });
  assert(rerunRevisions.length === 2, 'restartFromTask should snapshot the origin task and its descendants');
  assert(rerunRevisions.every((revision) => revision.previousStatus === 'done'), 'task revisions should capture previous done states before rerun');
  assert(rerunRevisions.some((revision) => revision.taskId === rerunOriginTask.taskId && revision.previousDoneSummary?.includes('包装器纠错重跑完成')), 'origin task revision should retain the previous doneSummary');
  assert(rerunRevisions.some((revision) => revision.taskId === rerunDescendantTaskIds[0] && revision.snapshot?.title === rerunDescendantTaskBeforeRestart.title), 'descendant task revision should retain the previous task snapshot');

  const rerunTaskSourceRef = createWorkflowTaskSourceRef(rerunWorkflow.workflow.workflowId, rerunOriginTask.taskId);
  const rerunTaskMemory = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sourceKind: 'workflow-task-rerun',
    sourceRef: rerunTaskSourceRef,
    graph: false,
    limit: 1
  });
  const rerunTaskContext = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: rerunWorkflow.workflow.workflowId,
    taskId: rerunOriginTask.taskId,
    sourceKind: 'workflow-task-rerun',
    sourceRef: rerunTaskSourceRef,
    limit: 1
  });
  assert(rerunTaskMemory.total === 1, 'restartFromTask should upsert one rerun memory record');
  assert(rerunTaskMemory.items[0].summary.includes('restarted from rerun origin'), 'rerun memory should store the rerun summary');
  assert(rerunTaskMemory.items[0].content.includes(`rerunReason: ${rerunReason}`), 'rerun memory should persist the rerun reason');
  assert(rerunTaskContext.total === 1, 'restartFromTask should upsert one rerun context item');
  assert(rerunTaskContext.items[0].metadata.kind === 'rerun', 'rerun context should mark the rerun metadata kind');
  assert(rerunTaskContext.items[0].metadata.rerunReason === rerunReason, 'rerun context should persist the rerun reason');
  assert(rerunTaskContext.items[0].metadata.rerunFingerprint === rerunFingerprint, 'rerun context should persist the rerun fingerprint');
  assert(rerunTaskContext.items[0].metadata.rerunOperator === 'smoke-test', 'rerun context should persist the rerun operator');
  assert(rerunTaskContext.items[0].metadata.descendantTaskIds.includes(rerunDescendantTaskIds[0]), 'rerun context should persist descendant task ids');
  assert(rerunTaskContext.items[0].content.includes('affectedDescendantTaskIds'), 'rerun context should record descendant ids in content');

  let rerunBudgetError = null;
  try {
    rerunWrapper.restartFromTask({
      workflowId: rerunWorkflow.workflow.workflowId,
      taskId: rerunOriginTask.taskId,
      reason: rerunReason,
      fingerprint: rerunFingerprint,
      operator: 'smoke-test',
      payload: { operator: 'smoke-test', mode: 'budget-check' },
      maxSameFingerprintReruns: 1
    });
  } catch (error) {
    rerunBudgetError = error;
  }
  assert(rerunBudgetError?.message.includes('Rerun budget exceeded'), 'restartFromTask should reject reruns that exceed the fingerprint budget');

  const rerunRunResult = await rerunWrapper.runWorkflow({
    workflowId: rerunWorkflow.workflow.workflowId,
    maxSteps: 20
  });
  assert(rerunRunResult.status === 'done', 'runWorkflow should finish after restartFromTask resets the origin task');
  assert(rerunRunResult.workflow.status === 'done', 'workflow should become done again after the rerun flow');

  const rerunRetryStep = rerunRunResult.steps.find((step) => step.contextSnapshot?.metadata?.hasRerunHint === true);
  assert(rerunRetryStep, 'rerun retry should expose a step with rerun hint metadata');
  assert(rerunRetryStep.prompt.includes('恢复信息：'), 'rerun retry prompt should render the rerun hint section');
  assert(rerunRetryStep.prompt.includes(rerunReason), 'rerun retry prompt should include the rerun reason');
  assert(rerunRetryStep.contextSnapshot?.metadata?.selectedReasons.includes('rerun-reason'), 'rerun retry snapshot should record why the rerun hint was selected');
  assert(rerunRetryStep.contextItems.some((item) => item.kind === 'rerun-hint'), 'rerun retry step should expose the rerun-hint item');
  assert(rerunRetryStep.adapterPayload?.promptHasContextSection === true, 'rerun retry adapter payload should confirm context prompt injection');

  console.log(JSON.stringify({
    doneWorkflowId: doneResult.workflow.workflowId,
    doneStepCount: doneResult.steps.length,
    doneSnapshotCount: doneTaskSnapshots.total,
    blockedWorkflowId: blockedResult.workflow.workflowId,
    resumedTaskId: resumed.task.taskId,
    blockedSnapshotCount: retriedTaskSnapshots.total,
    resumedStepCount: resumedRunResult.steps.length
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
