import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWorkflowTaskSourceRef,
  createChainStageSourceRef
} from '../internal.js';
import {
  createAgentContextSystem,
  createWorkflowEngine
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'context-smoke-test.db');

async function main() {
  await fs.rm(dbPath, { force: true });

  const contextSystem = await createAgentContextSystem({ dbPath });
  const shared = {
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'context-smoke-test'
  };

  const createdItem = contextSystem.writeItem({
    ...shared,
    kind: 'workflow-task-lifecycle',
    workflowId: 'wf-context',
    taskId: 'task-context',
    sourceKind: 'workflow-task',
    sourceRef: createWorkflowTaskSourceRef('wf-context', 'task-context'),
    title: 'Workflow task 分析上下文',
    summary: '记录最近错误与重试线索',
    content: [
      'workflowId: wf-context',
      'taskId: task-context',
      'lastError: 需要补充重试信息',
      'resumeMessage: 无'
    ].join('\n'),
    metadata: {
      kind: 'blocked',
      lastError: '需要补充重试信息'
    },
    priority: 96
  });

  assert(createdItem.item.contextId, 'writeItem should create a context item');
  assert(createdItem.item.priority === 96, 'writeItem should persist priority');

  const updatedItem = contextSystem.updateItem({
    contextId: createdItem.item.contextId,
    summary: '记录最近错误、恢复消息与重试线索',
    metadata: {
      kind: 'resumed',
      resumePayload: { operator: 'smoke-test' }
    },
    priority: 98
  });

  assert(updatedItem.item.summary.includes('恢复消息'), 'updateItem should persist the updated summary');
  assert(updatedItem.item.priority === 98, 'updateItem should update priority');
  assert(updatedItem.item.metadata.kind === 'resumed', 'updateItem should replace metadata');

  const stageItem = contextSystem.writeItem({
    ...shared,
    kind: 'chain-stage-lifecycle',
    workflowId: 'wf-context',
    chainId: 'chain-context',
    stageId: 'stage-context',
    sourceKind: 'chain-stage',
    sourceRef: createChainStageSourceRef('chain-context', 'stage-context'),
    title: 'Chain stage 输出结论',
    summary: '记录阶段交接与完成摘要',
    content: [
      'chainId: chain-context',
      'stageId: stage-context',
      'doneSummary: 已输出阶段结论'
    ].join('\n'),
    metadata: {
      kind: 'done',
      workflowStatus: 'done'
    },
    priority: 70
  });

  assert(stageItem.item.stageId === 'stage-context', 'writeItem should persist stage identifiers');

  const workflowItems = contextSystem.queryItems({
    ...shared,
    workflowId: 'wf-context',
    limit: 10
  });
  assert(workflowItems.total === 2, 'queryItems should return both workflow-related items');
  assert(workflowItems.items[0].priority >= workflowItems.items[1].priority, 'queryItems should order by priority desc');

  const sourceQuery = contextSystem.queryItems({
    ...shared,
    sourceKind: 'workflow-task',
    sourceRef: createWorkflowTaskSourceRef('wf-context', 'task-context'),
    limit: 1
  });
  assert(sourceQuery.total === 1, 'queryItems should filter by sourceKind and sourceRef');
  assert(sourceQuery.items[0].contextId === createdItem.item.contextId, 'source query should return the updated item');

  const stageQuery = contextSystem.queryItems({
    ...shared,
    chainId: 'chain-context',
    stageId: 'stage-context',
    limit: 5
  });
  assert(stageQuery.total === 1, 'queryItems should filter by chainId and stageId');
  assert(stageQuery.items[0].sourceKind === 'chain-stage', 'stage query should preserve sourceKind');

  const itemState = contextSystem.getItemState({
    contextId: createdItem.item.contextId
  });
  assert(itemState.item.metadata.resumePayload.operator === 'smoke-test', 'getItemState should return stored metadata');

  const snapshot = contextSystem.writeSnapshot({
    ...shared,
    workflowId: 'wf-context',
    taskId: 'task-context',
    sourceKind: 'workflow-task-snapshot',
    sourceRef: createWorkflowTaskSourceRef('wf-context', 'task-context'),
    title: 'Task context snapshot 分析上下文',
    summary: 'Selected 2 context items for task "分析上下文".',
    content: [
      '当前执行焦点：',
      '- 分析上下文｜补齐 runner context snapshot 断言',
      '',
      '恢复 / 阶段相关上下文：',
      '1. Workflow task 分析上下文｜记录最近错误、恢复消息与重试线索'
    ].join('\n'),
    items: [
      {
        kind: 'current-task',
        priority: 100,
        title: '分析上下文',
        summary: '补齐 runner context snapshot 断言',
        content: 'taskId: task-context',
        sourceKind: null,
        sourceRef: null,
        metadata: null
      },
      {
        kind: 'task-context',
        priority: 78,
        title: updatedItem.item.title,
        summary: updatedItem.item.summary,
        content: updatedItem.item.content,
        sourceKind: updatedItem.item.sourceKind,
        sourceRef: updatedItem.item.sourceRef,
        metadata: {
          contextId: updatedItem.item.contextId,
          taskId: updatedItem.item.taskId,
          updatedAt: updatedItem.item.updatedAt
        }
      }
    ],
    metadata: {
      workflowId: 'wf-context',
      taskId: 'task-context',
      candidateCount: 4,
      selectedCount: 2,
      relatedContextCount: 2
    }
  });

  assert(snapshot.snapshot.snapshotId, 'writeSnapshot should create a snapshot');
  assert(snapshot.snapshot.items.length === 2, 'writeSnapshot should persist snapshot items');
  assert(snapshot.snapshot.metadata.selectedCount === 2, 'writeSnapshot should persist snapshot metadata');

  const workflowSnapshots = contextSystem.querySnapshots({
    ...shared,
    workflowId: 'wf-context',
    taskId: 'task-context',
    limit: 10
  });
  assert(workflowSnapshots.total === 1, 'querySnapshots should return the matching snapshot');
  assert(workflowSnapshots.items[0].snapshotId === snapshot.snapshot.snapshotId, 'querySnapshots should return the created snapshot');

  const sourceSnapshots = contextSystem.querySnapshots({
    ...shared,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: createWorkflowTaskSourceRef('wf-context', 'task-context'),
    limit: 1
  });
  assert(sourceSnapshots.total === 1, 'querySnapshots should filter by sourceRef');
  assert(sourceSnapshots.items[0].content.includes('恢复 / 阶段相关上下文：'), 'snapshot content should remain auditable');

  const snapshotState = contextSystem.getSnapshotState({
    snapshotId: snapshot.snapshot.snapshotId
  });
  assert(snapshotState.snapshot.items[1].metadata.contextId === createdItem.item.contextId, 'getSnapshotState should return persisted snapshot items');

  const engine = await createWorkflowEngine({ dbPath });
  const workflow = engine.createWorkflowFromInstruction('验证 context store 不影响 workflow engine 核心流程');
  assert(workflow.workflow.status === 'ready', 'workflow engine should still initialize correctly with shared dbPath');

  console.log('context smoke test passed');
  console.log(JSON.stringify({
    contextItemIds: [createdItem.item.contextId, stageItem.item.contextId],
    workflowItemTotal: workflowItems.total,
    sourceSnapshotId: snapshot.snapshot.snapshotId,
    snapshotItemCount: snapshot.snapshot.items.length,
    workflowId: workflow.workflow.workflowId
  }, null, 2));
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
