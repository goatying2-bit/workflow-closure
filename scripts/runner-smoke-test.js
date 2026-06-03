import fs from 'node:fs/promises';
import {
  createWorkflowTaskSourceRef
} from '../internal.js';
import {
  createAgentContextSystem,
  createAgentMemorySystem,
  createAgentWorkflowWrapper,
  createWorkflowEngine,
  createWorkflowRunner,
  draftInitialPlan
} from '../index.js';
import { closeDb } from '../storage/db.js';
import { markTestPlan, prepareTestDb } from './helpers/test-db.js';

const dbPath = await prepareTestDb('runner-smoke-test');

async function main() {

  const engine = await createWorkflowEngine({ dbPath });
  const memorySystem = await createAgentMemorySystem({
    dbPath,
    semantic: {
      enabled: true,
      candidateLimit: 5,
      weight: 0.5,
      embedder: createSemanticTestEmbedder()
    }
  });
  const contextSystem = await createAgentContextSystem({ dbPath });
  const memoryOptions = {
    system: memorySystem,
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    limit: 6
  };
  const contextOptions = {
    system: contextSystem,
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    limit: 8
  };

  const doneRunner = await createWorkflowRunner({
    dbPath,
    engine,
    memory: memoryOptions,
    context: contextOptions,
    runnerId: 'runner-done',
    adapter: async ({ task, prompt, memoryContext, recalledMemories, activeMemoryContext, executionContext, contextSnapshot, contextItems }) => ({
      status: 'done',
      doneSummary: `自动完成：${task.title}`,
      payload: {
        taskId: task.taskId,
        promptHasMemorySection: prompt.includes('相关记忆：'),
        promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
        recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
        exactMemoryIds: Array.isArray(memoryContext?.exactItems) ? memoryContext.exactItems.map((item) => item.memoryId) : [],
        structuralMemoryIds: Array.isArray(memoryContext?.structuralItems) ? memoryContext.structuralItems.map((item) => item.memoryId) : [],
        graphMemoryIds: Array.isArray(memoryContext?.graphItems) ? memoryContext.graphItems.map((item) => item.memoryId) : [],
        semanticMemoryIds: Array.isArray(memoryContext?.semanticItems) ? memoryContext.semanticItems.map((item) => item.memoryId) : [],
        semanticReservedSlots: memoryContext?.query?.semanticReservedSlots ?? null,
        activeMemoryScope: activeMemoryContext?.scope || null,
        activeMemoryProjectKey: activeMemoryContext?.projectKey || null,
        activeMemoryWorkspacePath: activeMemoryContext?.workspacePath || null,
        activeMemoryLimit: activeMemoryContext?.limit ?? null,
        executionMemoryScope: executionContext?.memory?.scope || null,
        executionMemoryProjectKey: executionContext?.memory?.projectKey || null,
        executionMemoryWorkspacePath: executionContext?.memory?.workspacePath || null,
        executionMemoryLimit: executionContext?.memory?.limit ?? null,
        promptHasExecutionContextSection: prompt.includes('执行上下文：'),
        promptHasActiveMemoryLine: prompt.includes('- 活跃记忆:'),
        contextSnapshotId: contextSnapshot?.snapshotId || null,
        contextItemKinds: contextItems.map((item) => item.kind)
      }
    })
  });

  const completeWorkflow = engine.createWorkflowFromInstruction({
    instruction: '实现 runner 自动推进工作流',
    plan: markTestPlan({
      goal: '实现 runner 自动推进工作流',
      steps: [
        {
          key: 'runner-memory-wiring',
          title: '实现 runner 自动推进工作流',
          description: '验证 exact memory authoritative，semantic memory 作为补充召回。'
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const completeTask = completeWorkflow.tasks[0];
  const completeTaskSourceRef = createWorkflowTaskSourceRef(completeWorkflow.workflow.workflowId, completeTask.taskId);
  const exactSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Runner exact recall seed',
    summary: 'Exact recall should stay authoritative for the active task.',
    content: [
      '实现 runner 自动推进工作流。',
      '当前任务需要直接命中 sourceRef 对应的 workflow task memory。'
    ].join('\n'),
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    tags: ['runner', 'exact'],
    sourceKind: 'workflow-task',
    sourceRef: completeTaskSourceRef,
    subjectKind: 'workflow-task',
    subjectRef: completeTaskSourceRef,
    workflowId: completeWorkflow.workflow.workflowId,
    taskId: completeTask.taskId
  });
  const staleSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Runner stale seed',
    summary: 'Stale memory must not enter runner prompts.',
    content: '实现 runner 自动推进工作流 stale guidance that should be filtered out.',
    status: 'stale',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    tags: ['runner', 'stale'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-smoke-test:stale-seed'
  });
  const foreignWorkspaceSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Runner foreign workspace seed',
    summary: 'Foreign workspace memory must not enter runner prompts.',
    content: '实现 runner 自动推进工作流 foreign workspace guidance that should be filtered out.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/another-workspace',
    sessionId: 'runner-smoke-test',
    tags: ['runner', 'foreign-workspace'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-smoke-test:foreign-workspace'
  });
  const foreignProjectSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Runner foreign project seed',
    summary: 'Foreign project memory must not enter runner prompts.',
    content: '实现 runner 自动推进工作流 foreign project guidance that should be filtered out.',
    projectKey: 'other-project',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    tags: ['runner', 'foreign-project'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-smoke-test:foreign-project'
  });
  const semanticSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Runner semantic recall seed',
    summary: 'Semantic rerank target for runner smoke coverage.',
    content: '实现 runner 自动推进工作流 runner semantic target guidance',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    tags: ['runner', 'semantic'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-smoke-test:semantic-seed'
  });
  const invalidStructuredSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Runner invalid structured seed',
    summary: 'Same workflow/task metadata alone should not bypass the structured matcher.',
    content: 'This record shares workflow/task ids but is not a task or assignment lifecycle memory.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    tags: ['runner', 'structured'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-smoke-test:invalid-structured',
    subjectKind: 'smoke-test',
    subjectRef: 'runner-smoke-test:invalid-structured',
    workflowId: completeWorkflow.workflow.workflowId,
    taskId: completeTask.taskId
  });
  const rerunStructuralSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Runner rerun structured seed',
    summary: 'Rerun memories should remain structurally recallable for the same task.',
    content: 'This rerun memory should remain reachable through structured task recall.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    tags: ['runner', 'structured', 'rerun'],
    sourceKind: 'workflow-task-rerun',
    sourceRef: 'runner-smoke-test:rerun-structured',
    subjectKind: 'workflow-task-rerun',
    subjectRef: completeTaskSourceRef,
    workflowId: completeWorkflow.workflow.workflowId,
    taskId: completeTask.taskId,
    eventKind: 'rerun'
  });
  const graphLinkedSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Runner graph linked seed',
    summary: 'Graph-linked memory should be recalled through memory_links expansion.',
    content: 'Linked implementation note reachable only through graph expansion.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    tags: ['runner', 'graph'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-smoke-test:graph-linked',
    links: [
      {
        targetMemoryId: exactSeed.memory.memoryId,
        relation: 'supports'
      }
    ]
  });
  memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Runner semantic distractor',
    summary: 'Lexical distractor should not outrank the semantic target after rerank.',
    content: '实现 runner 自动推进工作流 runner lexical distractor',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    tags: ['runner', 'semantic'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-smoke-test:semantic-distractor'
  });

  let loopCount = 0;
  let lastResult = null;
  let lastActiveResult = null;

  while (loopCount < 20) {
    lastResult = await doneRunner.runOnce();
    if (lastResult.status !== 'idle') {
      lastActiveResult = lastResult;
    }
    if (lastResult.status === 'idle') {
      break;
    }
    loopCount += 1;
  }

  lastResult = lastActiveResult;

  const completedState = engine.getWorkflowState({ workflowId: completeWorkflow.workflow.workflowId });
  assert(completedState.workflow.status === 'done', 'runner should finish the workflow automatically');
  assert(completedState.tasks.every((task) => task.status === 'done'), 'all tasks should be done after runner loop');
  assert(completedState.runLogs.some((log) => log.action === 'task_claimed'), 'task claim log should exist');
  assert(completedState.runLogs.some((log) => log.action === 'task_completed_by_runner'), 'runner completion log should exist');
  assert(lastResult && lastResult.status !== 'blocked', 'runner should not block the happy path workflow');

  const completedTask = completedState.tasks.find((task) => task.status === 'done');
  const completedContextItems = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: completeWorkflow.workflow.workflowId,
    taskId: completedTask.taskId,
    sourceKind: 'workflow-task',
    sourceRef: completeTaskSourceRef,
    limit: 5
  });
  const completedSnapshots = contextSystem.querySnapshots({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: completeWorkflow.workflow.workflowId,
    taskId: completedTask.taskId,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: completeTaskSourceRef,
    limit: 20
  });

  assert(completedContextItems.total === 1, 'done task should upsert one lifecycle context item');
  assert(completedContextItems.items[0].summary.includes('自动完成'), 'done task context should store the completion summary');
  assert(completedSnapshots.total >= 1, 'runner should persist at least one task context snapshot');
  assert(completedSnapshots.items[0].metadata.selectedCount >= 1, 'snapshot metadata should record selected item count');
  assert(completedSnapshots.items[0].content.includes('当前执行焦点：'), 'snapshot content should include current task focus');
  assert(lastResult.adapterPayload?.promptHasMemorySection === true, 'runner should inject recalled memories into the prompt when relevant');
  assert(lastResult.adapterPayload?.recalledMemoryIds.includes(exactSeed.memory.memoryId), 'runner should expose exact recalled memory ids to the adapter');
  assert(lastResult.adapterPayload?.recalledMemoryIds.includes(semanticSeed.memory.memoryId), 'runner should expose semantic recalled memory ids to the adapter');
  assert(!lastResult.adapterPayload?.recalledMemoryIds.includes(staleSeed.memory.memoryId), 'runner should not expose stale recalled memories to the adapter');
  assert(!lastResult.adapterPayload?.recalledMemoryIds.includes(foreignWorkspaceSeed.memory.memoryId), 'runner should not expose foreign-workspace memories to the adapter');
  assert(!lastResult.adapterPayload?.recalledMemoryIds.includes(foreignProjectSeed.memory.memoryId), 'runner should not expose foreign-project memories to the adapter');
  assert(lastResult.adapterPayload?.exactMemoryIds.includes(exactSeed.memory.memoryId), 'exact memory should stay authoritative');
  assert(lastResult.adapterPayload?.structuralMemoryIds.includes(rerunStructuralSeed.memory.memoryId), 'rerun task memory should remain in structural recall');
  assert(!lastResult.adapterPayload?.structuralMemoryIds.includes(invalidStructuredSeed.memory.memoryId), 'same-task metadata alone should not pass structural recall');
  assert(lastResult.adapterPayload?.graphMemoryIds.includes(graphLinkedSeed.memory.memoryId), 'graph-linked memory should be exposed separately');
  assert(lastResult.adapterPayload?.semanticMemoryIds.includes(semanticSeed.memory.memoryId), 'semantic memory should be exposed separately');
  assert(Array.isArray(lastResult.memoryContext?.exactItems) && lastResult.memoryContext.exactItems.some((item) => item.memoryId === exactSeed.memory.memoryId), 'runOnce result should expose exactItems');
  assert(Array.isArray(lastResult.memoryContext?.structuralItems) && lastResult.memoryContext.structuralItems.some((item) => item.memoryId === rerunStructuralSeed.memory.memoryId), 'runOnce result should expose structuralItems');
  assert(Array.isArray(lastResult.memoryContext?.structuralItems) && lastResult.memoryContext.structuralItems.every((item) => item.memoryId !== invalidStructuredSeed.memory.memoryId), 'runOnce structuralItems should exclude invalid same-task records');
  assert(Array.isArray(lastResult.memoryContext?.graphItems) && lastResult.memoryContext.graphItems.some((item) => item.memoryId === graphLinkedSeed.memory.memoryId), 'runOnce result should expose graphItems');
  assert(Array.isArray(lastResult.memoryContext?.semanticItems) && lastResult.memoryContext.semanticItems.some((item) => item.memoryId === semanticSeed.memory.memoryId), 'runOnce result should expose semanticItems');
  assert(Array.isArray(lastResult.recalledMemories) && lastResult.recalledMemories.some((item) => item.memoryId === semanticSeed.memory.memoryId), 'runOnce result should expose recalledMemories');
  assert(lastResult.recalledMemories.every((item) => item.status === 'active'), 'runOnce recalled memories should only contain active entries');
  assert(lastResult.recalledMemories.every((item) => item.workspacePath === 'c:\\workspace\\workflow-closure'), 'runOnce recalled memories should stay in the canonical workspace');
  assert(lastResult.recalledMemories.every((item) => item.projectKey === 'workflow-closure'), 'runOnce recalled memories should stay in the active project');
  assert(completedSnapshots.items.some((snapshot) => snapshot.metadata?.exactMemoryCount >= 1), 'snapshot metadata should record exact memory count');
  assert(completedSnapshots.items.some((snapshot) => snapshot.metadata?.structuralMemoryCount >= 1), 'snapshot metadata should record structural memory count');
  assert(completedSnapshots.items.some((snapshot) => snapshot.metadata?.graphMemoryCount >= 1), 'snapshot metadata should record graph memory count');
  assert(completedSnapshots.items.some((snapshot) => snapshot.metadata?.semanticMemoryCount >= 1), 'snapshot metadata should record semantic memory count');
  assert(completedSnapshots.items.some((snapshot) => snapshot.items.some((item) => item.kind === 'memory-summary' && Array.isArray(item.selectedBecause) && item.selectedBecause.includes('exact-memory'))), 'snapshot items should label exact-memory selection reasons');
  assert(completedSnapshots.items.some((snapshot) => snapshot.items.some((item) => item.kind === 'memory-summary' && Array.isArray(item.selectedBecause) && item.selectedBecause.includes('structural-memory') && item.metadata?.memoryId === rerunStructuralSeed.memory.memoryId)), 'snapshot items should label structural-memory selection reasons');
  assert(completedSnapshots.items.some((snapshot) => snapshot.items.some((item) => item.kind === 'memory-summary' && Array.isArray(item.selectedBecause) && item.selectedBecause.includes('graph-memory') && item.metadata?.memoryId === graphLinkedSeed.memory.memoryId)), 'snapshot items should label graph-memory selection reasons');
  assert(completedSnapshots.items.some((snapshot) => snapshot.items.some((item) => item.kind === 'memory-summary' && Array.isArray(item.selectedBecause) && item.selectedBecause.includes('semantic-memory'))), 'snapshot items should label semantic-memory selection reasons');
  assert(completedSnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').every((item) => item.metadata?.memoryId !== staleSeed.memory.memoryId)), 'snapshots should exclude stale memory summaries');
  assert(completedSnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').every((item) => item.metadata?.memoryId !== invalidStructuredSeed.memory.memoryId)), 'snapshots should exclude invalid same-task structural memories');
  assert(completedSnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').every((item) => item.metadata?.memoryId !== foreignWorkspaceSeed.memory.memoryId)), 'snapshots should exclude foreign-workspace memory summaries');
  assert(completedSnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').every((item) => item.metadata?.memoryId !== foreignProjectSeed.memory.memoryId)), 'snapshots should exclude foreign-project memory summaries');
  assert(lastResult.prompt.includes('matchedBy: exact-source-ref'), 'prompt should render exact memory matchedBy metadata');
  assert(lastResult.prompt.includes('matchedBy: semantic'), 'prompt should render semantic memory matchedBy metadata');
  assert(lastResult.adapterPayload?.semanticReservedSlots === 3, 'runner should reserve semantic slots under the default memory limit');
  assert(lastResult.adapterPayload?.activeMemoryScope === 'workspace', 'active memory context should preserve the workspace scope');
  assert(lastResult.adapterPayload?.activeMemoryProjectKey === 'workflow-closure', 'active memory context should preserve the project key');
  assert(normalizeWorkspacePathForAssert(lastResult.adapterPayload?.activeMemoryWorkspacePath) === 'c:/workspace/workflow-closure', 'active memory context should preserve the workspace path before prompt rendering');
  assert(lastResult.adapterPayload?.activeMemoryLimit === 6, 'active memory context should preserve the configured limit');
  assert(lastResult.adapterPayload?.executionMemoryScope === 'workspace', 'execution memory context should expose the workspace scope');
  assert(lastResult.adapterPayload?.executionMemoryProjectKey === 'workflow-closure', 'execution memory context should expose the project key');
  assert(normalizeWorkspacePathForAssert(lastResult.adapterPayload?.executionMemoryWorkspacePath) === 'c:/workspace/workflow-closure', 'execution memory context should expose the workspace path');
  assert(lastResult.adapterPayload?.executionMemoryLimit === 6, 'execution memory context should expose the configured limit');
  assert(lastResult.adapterPayload?.promptHasExecutionContextSection === true, 'runner prompt should render the execution context section');
  assert(lastResult.adapterPayload?.promptHasActiveMemoryLine === true, 'runner prompt should render the active memory line inside execution context');

  const tightLimitWorkflow = engine.createWorkflowFromInstruction({
    instruction: '实现 runner 自动推进工作流（紧限额语义保活）',
    plan: markTestPlan({
      goal: '实现 runner 自动推进工作流（紧限额语义保活）',
      steps: [
        {
          key: 'tight-limit-semantic-lane',
          title: '在紧限额下保留语义记忆',
          description: '即使 exact / structural / graph 都存在，也要保住一个 semantic slot。'
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const tightLimitTask = tightLimitWorkflow.tasks[0];
  const tightLimitTaskSourceRef = createWorkflowTaskSourceRef(tightLimitWorkflow.workflow.workflowId, tightLimitTask.taskId);
  const tightLimitExactSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Tight limit exact seed',
    summary: 'Tight limit runner should still keep the exact task memory.',
    content: '实现 runner 自动推进工作流 tight limit exact memory',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-tight-limit',
    tags: ['runner', 'tight-limit', 'exact'],
    sourceKind: 'workflow-task',
    sourceRef: tightLimitTaskSourceRef,
    subjectKind: 'workflow-task',
    subjectRef: tightLimitTaskSourceRef,
    workflowId: tightLimitWorkflow.workflow.workflowId,
    taskId: tightLimitTask.taskId
  });
  const tightLimitStructuralSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Tight limit structural seed',
    summary: 'Structured seed should exist but lose to the exact+semantic final window.',
    content: 'tight limit structural memory for the same task',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-tight-limit',
    tags: ['runner', 'tight-limit', 'structured'],
    sourceKind: 'workflow-task-rerun',
    sourceRef: 'runner-tight-limit:rerun-structured',
    subjectKind: 'workflow-task-rerun',
    subjectRef: tightLimitTaskSourceRef,
    workflowId: tightLimitWorkflow.workflow.workflowId,
    taskId: tightLimitTask.taskId,
    eventKind: 'rerun'
  });
  const tightLimitGraphSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Tight limit graph seed',
    summary: 'Graph seed should exist but not consume the full final window.',
    content: 'tight limit graph memory linked from the exact seed',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-tight-limit',
    tags: ['runner', 'tight-limit', 'graph'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-tight-limit:graph-seed',
    links: [
      {
        targetMemoryId: tightLimitExactSeed.memory.memoryId,
        relation: 'supports'
      }
    ]
  });
  const tightLimitSemanticSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Tight limit semantic seed',
    summary: 'Semantic seed must survive even when the final limit is only two.',
    content: '实现 runner 自动推进工作流 runner semantic target guidance tight limit',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-tight-limit',
    tags: ['runner', 'tight-limit', 'semantic'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-tight-limit:semantic-seed'
  });
  memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Tight limit semantic distractor',
    summary: 'Distractor should not displace the semantic target in the reserved lane.',
    content: '实现 runner 自动推进工作流 runner lexical distractor tight limit',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-tight-limit',
    tags: ['runner', 'tight-limit', 'semantic'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-tight-limit:semantic-distractor'
  });
  const tightLimitRunner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: tightLimitWorkflow.workflow.workflowId,
    memory: {
      ...memoryOptions,
      sessionId: 'runner-tight-limit',
      limit: 2
    },
    context: contextOptions,
    runnerId: 'runner-tight-limit',
    adapter: async ({ task, prompt, memoryContext, recalledMemories, activeMemoryContext, executionContext, contextSnapshot, contextItems }) => ({
      status: 'done',
      doneSummary: `紧限额完成：${task.title}`,
      payload: {
        taskId: task.taskId,
        promptHasMemorySection: prompt.includes('相关记忆：'),
        promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
        recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
        exactMemoryIds: Array.isArray(memoryContext?.exactItems) ? memoryContext.exactItems.map((item) => item.memoryId) : [],
        structuralMemoryIds: Array.isArray(memoryContext?.structuralItems) ? memoryContext.structuralItems.map((item) => item.memoryId) : [],
        graphMemoryIds: Array.isArray(memoryContext?.graphItems) ? memoryContext.graphItems.map((item) => item.memoryId) : [],
        semanticMemoryIds: Array.isArray(memoryContext?.semanticItems) ? memoryContext.semanticItems.map((item) => item.memoryId) : [],
        semanticReservedSlots: memoryContext?.query?.semanticReservedSlots ?? null,
        activeMemoryScope: activeMemoryContext?.scope || null,
        activeMemoryProjectKey: activeMemoryContext?.projectKey || null,
        activeMemoryWorkspacePath: activeMemoryContext?.workspacePath || null,
        activeMemoryLimit: activeMemoryContext?.limit ?? null,
        executionMemoryScope: executionContext?.memory?.scope || null,
        executionMemoryProjectKey: executionContext?.memory?.projectKey || null,
        executionMemoryWorkspacePath: executionContext?.memory?.workspacePath || null,
        executionMemoryLimit: executionContext?.memory?.limit ?? null,
        promptHasExecutionContextSection: prompt.includes('执行上下文：'),
        promptHasActiveMemoryLine: prompt.includes('- 活跃记忆:'),
        contextSnapshotId: contextSnapshot?.snapshotId || null,
        contextItemKinds: contextItems.map((item) => item.kind)
      }
    })
  });
  const tightLimitStep = await tightLimitRunner.runOnce();
  const tightLimitSnapshots = contextSystem.querySnapshots({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: tightLimitWorkflow.workflow.workflowId,
    taskId: tightLimitTask.taskId,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: tightLimitTaskSourceRef,
    limit: 10
  });

  assert(tightLimitStep.status === 'done', 'tight-limit workflow should complete in one runner step');
  assert(tightLimitStep.adapterPayload?.semanticReservedSlots === 1, 'tight-limit runner should reserve one semantic slot');
  assert(tightLimitStep.adapterPayload?.recalledMemoryIds.length === 2, 'tight-limit runner should cap the final memory window at two items');
  assert(tightLimitStep.adapterPayload?.recalledMemoryIds.includes(tightLimitExactSeed.memory.memoryId), 'tight-limit runner should still keep the exact seed');
  assert(tightLimitStep.adapterPayload?.recalledMemoryIds.includes(tightLimitSemanticSeed.memory.memoryId), 'tight-limit runner should keep the semantic seed inside the reserved lane');
  assert(!tightLimitStep.adapterPayload?.recalledMemoryIds.includes(tightLimitStructuralSeed.memory.memoryId), 'tight-limit runner should not let structural seed crowd out the semantic lane');
  assert(!tightLimitStep.adapterPayload?.recalledMemoryIds.includes(tightLimitGraphSeed.memory.memoryId), 'tight-limit runner should not let graph seed crowd out the semantic lane');
  assert(tightLimitStep.adapterPayload?.exactMemoryIds.includes(tightLimitExactSeed.memory.memoryId), 'tight-limit runner should still expose the exact lane');
  assert(tightLimitStep.adapterPayload?.structuralMemoryIds.includes(tightLimitStructuralSeed.memory.memoryId), 'tight-limit runner should still compute structural candidates before final capping');
  assert(tightLimitStep.adapterPayload?.graphMemoryIds.includes(tightLimitGraphSeed.memory.memoryId), 'tight-limit runner should still compute graph candidates before final capping');
  assert(tightLimitStep.adapterPayload?.semanticMemoryIds.includes(tightLimitSemanticSeed.memory.memoryId), 'tight-limit runner should expose the semantic lane separately');
  assert(tightLimitStep.prompt.includes('Tight limit semantic seed'), 'tight-limit prompt should still render the semantic seed');
  assert(!tightLimitStep.prompt.includes('Tight limit structural seed'), 'tight-limit prompt should not render the structural seed once the final window is capped');
  assert(!tightLimitStep.prompt.includes('Tight limit graph seed'), 'tight-limit prompt should not render the graph seed once the final window is capped');
  assert(tightLimitSnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').some((item) => item.metadata?.memoryId === tightLimitSemanticSeed.memory.memoryId)), 'tight-limit snapshots should retain the semantic memory summary');
  assert(tightLimitSnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').every((item) => item.metadata?.memoryId !== tightLimitStructuralSeed.memory.memoryId)), 'tight-limit snapshots should exclude structural memories that lost the final window');
  assert(tightLimitSnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').every((item) => item.metadata?.memoryId !== tightLimitGraphSeed.memory.memoryId)), 'tight-limit snapshots should exclude graph memories that lost the final window');

  const visibilityWorkflow = engine.createWorkflowFromInstruction({
    instruction: '实现 runner 自动推进工作流（visibility memory boundary）',
    plan: markTestPlan({
      goal: '实现 runner 自动推进工作流（visibility memory boundary）',
      steps: [
        {
          key: 'visibility-memory-boundary',
          title: '只暴露 agent visibility 允许的记忆',
          description: 'executionContext.memory 必须成为真实的 recall 边界。'
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const visibilityTask = visibilityWorkflow.tasks[0];
  const visibilityTaskSourceRef = createWorkflowTaskSourceRef(visibilityWorkflow.workflow.workflowId, visibilityTask.taskId);
  const visibilityAllowedExactSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Visibility allowed exact seed',
    summary: 'Allowed exact seed should be visible to the runner prompt.',
    content: '实现 runner 自动推进工作流 visibility allowed exact memory',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-visibility-allowed',
    tags: ['runner', 'visibility', 'exact'],
    sourceKind: 'workflow-task',
    sourceRef: visibilityTaskSourceRef,
    subjectKind: 'workflow-task',
    subjectRef: visibilityTaskSourceRef,
    workflowId: visibilityWorkflow.workflow.workflowId,
    taskId: visibilityTask.taskId
  });
  const visibilityDeniedExactSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Visibility denied exact seed',
    summary: 'Denied exact seed must be filtered by execution visibility.',
    content: '实现 runner 自动推进工作流 visibility denied exact memory',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-visibility-denied',
    tags: ['runner', 'visibility', 'exact'],
    sourceKind: 'workflow-task',
    sourceRef: visibilityTaskSourceRef,
    subjectKind: 'workflow-task',
    subjectRef: visibilityTaskSourceRef,
    workflowId: visibilityWorkflow.workflow.workflowId,
    taskId: visibilityTask.taskId
  });
  const visibilityAllowedSemanticSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Visibility allowed semantic seed',
    summary: 'Allowed semantic seed should survive the narrowed memory boundary.',
    content: '实现 runner 自动推进工作流 runner semantic target guidance visibility allowed',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-visibility-allowed',
    tags: ['runner', 'visibility', 'semantic'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-visibility:semantic-allowed'
  });
  const visibilityDeniedSemanticSeed = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Visibility denied semantic seed',
    summary: 'Denied semantic seed must never appear outside the narrowed boundary.',
    content: '实现 runner 自动推进工作流 runner semantic target guidance visibility denied',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-visibility-denied',
    tags: ['runner', 'visibility', 'semantic'],
    sourceKind: 'smoke-test',
    sourceRef: 'runner-visibility:semantic-denied'
  });
  const visibilityRunner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: visibilityWorkflow.workflow.workflowId,
    memory: memoryOptions,
    context: contextOptions,
    runnerId: 'runner-visibility',
    agentIdentity: {
      agentId: 'visibility-agent',
      name: 'Visibility Agent',
      role: 'implementer',
      visibility: {
        memory: {
          scope: 'workspace',
          projectKey: 'workflow-closure',
          workspacePath: 'C:/workspace/workflow-closure',
          sessionId: 'runner-visibility-allowed',
          limit: 2
        }
      }
    },
    adapter: async ({ task, prompt, memoryContext, recalledMemories, activeMemoryContext, executionContext, contextSnapshot, contextItems }) => ({
      status: 'done',
      doneSummary: `visibility 完成：${task.title}`,
      payload: {
        taskId: task.taskId,
        promptHasMemorySection: prompt.includes('相关记忆：'),
        promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
        recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
        exactMemoryIds: Array.isArray(memoryContext?.exactItems) ? memoryContext.exactItems.map((item) => item.memoryId) : [],
        structuralMemoryIds: Array.isArray(memoryContext?.structuralItems) ? memoryContext.structuralItems.map((item) => item.memoryId) : [],
        graphMemoryIds: Array.isArray(memoryContext?.graphItems) ? memoryContext.graphItems.map((item) => item.memoryId) : [],
        semanticMemoryIds: Array.isArray(memoryContext?.semanticItems) ? memoryContext.semanticItems.map((item) => item.memoryId) : [],
        semanticReservedSlots: memoryContext?.query?.semanticReservedSlots ?? null,
        activeMemoryScope: activeMemoryContext?.scope || null,
        activeMemoryProjectKey: activeMemoryContext?.projectKey || null,
        activeMemoryWorkspacePath: activeMemoryContext?.workspacePath || null,
        activeMemoryLimit: activeMemoryContext?.limit ?? null,
        executionMemoryScope: executionContext?.memory?.scope || null,
        executionMemoryProjectKey: executionContext?.memory?.projectKey || null,
        executionMemoryWorkspacePath: executionContext?.memory?.workspacePath || null,
        executionMemoryLimit: executionContext?.memory?.limit ?? null,
        promptHasExecutionContextSection: prompt.includes('执行上下文：'),
        promptHasActiveMemoryLine: prompt.includes('- 活跃记忆:'),
        contextSnapshotId: contextSnapshot?.snapshotId || null,
        contextItemKinds: contextItems.map((item) => item.kind)
      }
    })
  });
  const visibilityStep = await visibilityRunner.runOnce();
  const visibilitySnapshots = contextSystem.querySnapshots({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: visibilityWorkflow.workflow.workflowId,
    taskId: visibilityTask.taskId,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: visibilityTaskSourceRef,
    limit: 10
  });

  assert(visibilityStep.status === 'done', 'visibility workflow should complete in one runner step');
  assert(visibilityStep.adapterPayload?.semanticReservedSlots === 1, 'visibility runner should reserve one semantic slot under the narrowed limit');
  assert(visibilityStep.adapterPayload?.activeMemoryScope === 'workspace', 'active memory scope should respect the visibility boundary');
  assert(visibilityStep.adapterPayload?.activeMemoryProjectKey === 'workflow-closure', 'active memory project should respect the visibility boundary');
  assert(normalizeWorkspacePathForAssert(visibilityStep.adapterPayload?.activeMemoryWorkspacePath) === 'c:/workspace/workflow-closure', 'active memory workspace should respect the visibility boundary');
  assert(visibilityStep.adapterPayload?.activeMemoryLimit === 2, 'active memory limit should be narrowed by agent visibility');
  assert(visibilityStep.adapterPayload?.executionMemoryScope === 'workspace', 'execution memory scope should match the narrowed boundary');
  assert(visibilityStep.adapterPayload?.executionMemoryProjectKey === 'workflow-closure', 'execution memory project should match the narrowed boundary');
  assert(normalizeWorkspacePathForAssert(visibilityStep.adapterPayload?.executionMemoryWorkspacePath) === 'c:/workspace/workflow-closure', 'execution memory workspace should match the narrowed boundary');
  assert(visibilityStep.adapterPayload?.executionMemoryLimit === 2, 'execution memory limit should match the narrowed boundary');
  assert(visibilityStep.adapterPayload?.promptHasExecutionContextSection === true, 'visibility runner prompt should render execution context');
  assert(visibilityStep.adapterPayload?.promptHasActiveMemoryLine === true, 'visibility runner prompt should render the active memory line');
  assert(visibilityStep.adapterPayload?.recalledMemoryIds.includes(visibilityAllowedExactSeed.memory.memoryId), 'visibility runner should include the allowed exact seed');
  assert(visibilityStep.adapterPayload?.recalledMemoryIds.includes(visibilityAllowedSemanticSeed.memory.memoryId), 'visibility runner should include the allowed semantic seed');
  assert(!visibilityStep.adapterPayload?.recalledMemoryIds.includes(visibilityDeniedExactSeed.memory.memoryId), 'visibility runner should exclude the denied exact seed from adapter payloads');
  assert(!visibilityStep.adapterPayload?.recalledMemoryIds.includes(visibilityDeniedSemanticSeed.memory.memoryId), 'visibility runner should exclude the denied semantic seed from adapter payloads');
  assert(visibilityStep.recalledMemories.every((item) => item.sessionId === 'runner-visibility-allowed'), 'visibility runner should only expose memories inside the narrowed session boundary');
  assert(visibilityStep.prompt.includes('Visibility allowed exact seed'), 'visibility prompt should include the allowed exact seed');
  assert(visibilityStep.prompt.includes('Visibility allowed semantic seed'), 'visibility prompt should include the allowed semantic seed');
  assert(!visibilityStep.prompt.includes('Visibility denied exact seed'), 'visibility prompt should exclude denied exact seed text');
  assert(!visibilityStep.prompt.includes('Visibility denied semantic seed'), 'visibility prompt should exclude denied semantic seed text');
  assert(visibilityStep.prompt.includes('- 活跃记忆: scope=workspace｜project=workflow-closure｜workspace=C:/workspace/workflow-closure｜limit=2｜recalled=2'), 'visibility prompt should render the narrowed execution-memory line');
  assert(visibilityStep.prompt.includes('sessionId: runner-visibility-allowed'), 'visibility prompt should render the narrowed session id');
  assert(visibilitySnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').some((item) => item.metadata?.memoryId === visibilityAllowedExactSeed.memory.memoryId)), 'visibility snapshots should retain the allowed exact memory summary');
  assert(visibilitySnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').some((item) => item.metadata?.memoryId === visibilityAllowedSemanticSeed.memory.memoryId)), 'visibility snapshots should retain the allowed semantic memory summary');
  assert(visibilitySnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').every((item) => item.metadata?.memoryId !== visibilityDeniedExactSeed.memory.memoryId)), 'visibility snapshots should exclude denied exact memories');
  assert(visibilitySnapshots.items.every((snapshot) => snapshot.items.filter((item) => item.kind === 'memory-summary').every((item) => item.metadata?.memoryId !== visibilityDeniedSemanticSeed.memory.memoryId)), 'visibility snapshots should exclude denied semantic memories');


  let flakyAttempts = 0;
  const retryRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    runnerId: 'runner-retry-once',
    maxTaskRetries: 2,
    adapter: async ({ task, prompt, contextSnapshot }) => {
      flakyAttempts += 1;
      if (flakyAttempts === 1) {
        throw new Error(`瞬时失败：${task.title}`);
      }

      return {
        status: 'done',
        doneSummary: `重试后完成：${task.title}`,
        payload: {
          taskId: task.taskId,
          prompt,
          contextSnapshotId: contextSnapshot?.snapshotId || null,
          flakyAttempts
        }
      };
    }
  });

  const retryWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 runner 可以自动重试一次瞬时失败',
    plan: markTestPlan({
      goal: '验证 runner 可以自动重试一次瞬时失败',
      steps: [
        {
          key: 'retry-once',
          title: '处理一次瞬时失败后继续完成',
          description: '第一次抛错，第二次完成'
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const retryFirstStep = await retryRunner.runOnce();
  const retryStateAfterFirstFailure = engine.getWorkflowState({ workflowId: retryWorkflow.workflow.workflowId });
  const retryTaskAfterFirstFailure = retryStateAfterFirstFailure.tasks[0];
  const retrySecondStep = await retryRunner.runOnce();
  const retryFinalState = engine.getWorkflowState({ workflowId: retryWorkflow.workflow.workflowId });
  const retryFinalTask = retryFinalState.tasks[0];

  const retrySchedulingLog = [...retryStateAfterFirstFailure.runLogs].reverse().find((log) => log.taskId === retryTaskAfterFirstFailure.taskId && log.action === 'task_retry_scheduled_by_runner') || null;

  assert(retryFirstStep.status === 'ready', 'thrown execution error should schedule retry instead of blocking immediately');
  assert(retryTaskAfterFirstFailure.status === 'ready', 'retryable task should move back to ready');
  assert(retryTaskAfterFirstFailure.attemptCount === 1, 'first failed attempt should preserve the current attempt count');
  assert(retryTaskAfterFirstFailure.lastError === `瞬时失败：${retryTaskAfterFirstFailure.title}`, 'retryable task should persist lastError after thrown failure');
  assert(retryTaskAfterFirstFailure.reasonCode === 'runner_execution_retry', 'retryable task should persist the retry reason code');
  assert(retrySchedulingLog?.payload?.recovery?.reasonCode === 'runner_execution_retry', 'retry scheduling log should store the retry reason code');
  assert(retryStateAfterFirstFailure.runLogs.some((log) => log.action === 'task_retry_scheduled_by_runner'), 'retry scheduling log should exist');
  assert(retrySecondStep.status === 'done', 'second attempt should complete after retry');
  assert(retrySecondStep.prompt.includes(`最近错误: ${retryTaskAfterFirstFailure.lastError}`), 'retry prompt should include the last thrown error');
  assert(retryFinalState.workflow.status === 'done', 'workflow should finish after automatic retry succeeds');
  assert(retryFinalTask.status === 'done', 'task should complete after automatic retry succeeds');
  assert(retryFinalTask.attemptCount === 2, 'successful retry should increment attempt count on the second claim');
  assert(retryFinalTask.reasonCode == null, 'successful retry should clear the persisted reason code after completion');
  assert(flakyAttempts === 2, 'adapter should run twice for throw-once retry coverage');

  let timeoutAttempts = 0;
  const timeoutWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 runner 执行超时后自动重试',
    plan: markTestPlan({
      goal: '验证 runner 执行超时后自动重试',
      steps: [
        {
          key: 'timeout-retry',
          title: '首次超时后继续完成',
          description: '第一次执行超过 timeout，第二次完成'
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const timeoutRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: timeoutWorkflow.workflow.workflowId,
    runnerId: 'runner-timeout-retry',
    maxTaskRetries: 1,
    taskExecutionTimeoutMs: 20,
    adapter: async ({ task }) => {
      timeoutAttempts += 1;
      if (timeoutAttempts === 1) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw new Error('first timeout adapter continued after timeout');
      }

      return {
        status: 'done',
        doneSummary: `超时重试后完成：${task.title}`,
        payload: { timeoutAttempts }
      };
    }
  });

  const timeoutFirstStep = await timeoutRunner.runOnce();
  const timeoutStateAfterFirst = engine.getWorkflowState({ workflowId: timeoutWorkflow.workflow.workflowId });
  const timeoutTaskAfterFirst = timeoutStateAfterFirst.tasks[0];
  const timeoutSecondStep = await timeoutRunner.runOnce();
  const timeoutFinalState = engine.getWorkflowState({ workflowId: timeoutWorkflow.workflow.workflowId });
  const timeoutFinalTask = timeoutFinalState.tasks[0];

  assert(timeoutFirstStep.status === 'ready', 'execution timeout should schedule retry when budget remains');
  assert(timeoutTaskAfterFirst.status === 'ready', 'timed-out task should move back to ready');
  assert(timeoutTaskAfterFirst.reasonCode === 'runner_execution_timeout', 'timed-out task should persist timeout reason code');
  assert(timeoutTaskAfterFirst.lastError.includes('timed out'), 'timed-out task should persist timeout error');
  assert(timeoutStateAfterFirst.runLogs.some((log) => log.action === 'task_timeout_retry_scheduled_by_runner'), 'timeout retry scheduling log should exist');
  assert(timeoutSecondStep.status === 'done', 'second timeout attempt should complete');
  assert(timeoutFinalState.workflow.status === 'done', 'timeout retry workflow should finish');
  assert(timeoutFinalTask.status === 'done', 'timeout retry task should finish');
  assert(timeoutFinalTask.attemptCount === 2, 'timeout retry should increment attempt count on second claim');

  let contractExecutionTimeoutAttempts = 0;
  const contractExecutionTimeoutWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 task contract executionTimeoutMs 覆盖 runner 默认值',
    plan: markTestPlan({
      goal: '验证 task contract executionTimeoutMs 覆盖 runner 默认值',
      steps: [
        {
          key: 'contract-execution-timeout',
          title: '任务级执行超时覆盖 runner 默认值',
          description: '即使 runner 默认超时更长，task contract 的 executionTimeoutMs 也应先生效',
          contract: {
            executionTimeoutMs: 20,
            timeoutReason: 'Task contract execution timeout override.'
          }
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const contractExecutionTimeoutRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: contractExecutionTimeoutWorkflow.workflow.workflowId,
    runnerId: 'runner-contract-execution-timeout',
    maxTaskRetries: 0,
    taskExecutionTimeoutMs: 200,
    adapter: async () => {
      contractExecutionTimeoutAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        status: 'done',
        doneSummary: 'task contract execution timeout should win over runner default'
      };
    }
  });

  const contractExecutionTimeoutStep = await contractExecutionTimeoutRunner.runOnce();
  const contractExecutionTimeoutState = engine.getWorkflowState({ workflowId: contractExecutionTimeoutWorkflow.workflow.workflowId });
  const contractExecutionTimeoutTask = contractExecutionTimeoutState.tasks[0];

  assert(contractExecutionTimeoutStep.status === 'blocked', 'task contract executionTimeoutMs should override runner default timeout');
  assert(contractExecutionTimeoutAttempts === 1, 'task contract execution timeout override should still execute the adapter once');
  assert(contractExecutionTimeoutTask.status === 'blocked', 'task contract execution timeout override should block when maxTaskRetries is zero');
  assert(contractExecutionTimeoutTask.reasonCode === 'runner_execution_timeout', 'task contract execution timeout override should persist timeout reason code');
  assert(contractExecutionTimeoutTask.lastError.includes('after 20ms'), 'task contract execution timeout override should use the task-level timeout in the error');
  assert(contractExecutionTimeoutState.runLogs.some((log) => log.action === 'task_timeout_by_runner'), 'task contract execution timeout override should write the timeout block log');

  const contractStalledWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 task contract stalledTimeoutMs 覆盖 runner maintenance 默认值',
    plan: markTestPlan({
      goal: '验证 task contract stalledTimeoutMs 覆盖 runner maintenance 默认值',
      steps: [
        {
          key: 'contract-stalled-timeout',
          title: '任务级 stalled timeout 覆盖 maintenance 默认值',
          description: '即使 runner sweep stalled timeout 更长，task contract 的 stalledTimeoutMs 也应先生效',
          contract: {
            stalledTimeoutMs: 20,
            timeoutReason: 'Task contract stalled timeout override.'
          }
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const contractStalledClaim = engine.claimNextReadyTask({
    workflowId: contractStalledWorkflow.workflow.workflowId,
    leaseOwner: 'runner-contract-stalled-stale',
    leaseMs: 60_000
  });
  await sleep(40);

  let contractStalledAdapterCalls = 0;
  const contractStalledRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: contractStalledWorkflow.workflow.workflowId,
    runnerId: 'runner-contract-stalled-timeout',
    timeoutSweepMaxExecutionMs: 200,
    timeoutSweepStalledMs: 200,
    timeoutSweepMaxAttempts: 2,
    timeoutSweepIntervalMs: 0,
    adapter: async ({ task }) => {
      contractStalledAdapterCalls += 1;
      return {
        status: 'done',
        doneSummary: `stalled override recovered: ${task.title}`
      };
    }
  });

  const contractStalledStep = await contractStalledRunner.runOnce();
  const contractStalledState = engine.getWorkflowState({ workflowId: contractStalledWorkflow.workflow.workflowId });
  const contractStalledTask = contractStalledState.tasks.find((task) => task.taskId === contractStalledClaim.task.taskId);
  const contractStalledLog = [...contractStalledState.runLogs].reverse().find((log) => log.taskId === contractStalledClaim.task.taskId && log.action === 'task_timeout_released') || null;

  assert(contractStalledStep.status === 'done', 'task contract stalledTimeoutMs should let maintenance reclaim and run the task');
  assert(contractStalledStep.sweptReleasedTaskCount === 1, 'task contract stalledTimeoutMs should be honored by maintenance sweep');
  assert(contractStalledAdapterCalls === 1, 'task contract stalled timeout override should reclaim exactly one task for execution');
  assert(contractStalledTask?.status === 'done', 'task contract stalled timeout override should let the reclaimed task complete');
  assert(contractStalledLog?.payload?.timeoutKind === 'stalled', 'task contract stalled timeout override should classify the task as stalled');

  const contractSweepOverrideWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 task contract maxTimeoutAttempts 和 timeoutReason 覆盖 runner maintenance 默认值',
    plan: markTestPlan({
      goal: '验证 task contract maxTimeoutAttempts 和 timeoutReason 覆盖 runner maintenance 默认值',
      steps: [
        {
          key: 'contract-sweep-overrides',
          title: '任务级 timeout sweep budget 和 reason 覆盖默认值',
          description: 'task contract 应覆盖 maintenance 的 max attempts 和 reason',
          contract: {
            executionTimeoutMs: 20,
            maxTimeoutAttempts: 1,
            timeoutReason: 'Task contract timeout reason override.'
          }
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const contractSweepOverrideClaim = engine.claimNextReadyTask({
    workflowId: contractSweepOverrideWorkflow.workflow.workflowId,
    leaseOwner: 'runner-contract-sweep-override-stale',
    leaseMs: 60_000
  });
  await sleep(40);

  let contractSweepOverrideAdapterCalled = false;
  const contractSweepOverrideRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: contractSweepOverrideWorkflow.workflow.workflowId,
    runnerId: 'runner-contract-sweep-override',
    timeoutSweepMaxExecutionMs: 200,
    timeoutSweepMaxAttempts: 5,
    timeoutSweepIntervalMs: 0,
    timeoutSweepReason: 'runner default timeout reason should be ignored',
    adapter: async () => {
      contractSweepOverrideAdapterCalled = true;
      return {
        status: 'done',
        doneSummary: 'contract sweep override should block before adapter execution'
      };
    }
  });

  const contractSweepOverrideStep = await contractSweepOverrideRunner.runOnce();
  const contractSweepOverrideState = engine.getWorkflowState({ workflowId: contractSweepOverrideWorkflow.workflow.workflowId });
  const contractSweepOverrideTask = contractSweepOverrideState.tasks.find((task) => task.taskId === contractSweepOverrideClaim.task.taskId);
  const contractSweepOverrideLog = [...contractSweepOverrideState.runLogs].reverse().find((log) => log.taskId === contractSweepOverrideClaim.task.taskId && log.action === 'task_timeout_blocked') || null;

  assert(contractSweepOverrideStep.status === 'idle', 'task contract maxTimeoutAttempts should block stale work before adapter execution');
  assert(contractSweepOverrideStep.sweptBlockedTaskCount === 1, 'task contract maxTimeoutAttempts should be honored by maintenance sweep');
  assert(contractSweepOverrideAdapterCalled === false, 'task contract maxTimeoutAttempts override should prevent adapter execution after blocking');
  assert(contractSweepOverrideTask?.status === 'blocked', 'task contract maxTimeoutAttempts override should persist blocked status');
  assert(contractSweepOverrideTask?.reasonCode === 'runner_execution_timeout', 'task contract maxTimeoutAttempts override should keep timeout reason code');
  assert(contractSweepOverrideTask?.lastError.includes('Task contract timeout reason override.'), 'task contract timeoutReason override should persist on the task');
  assert(contractSweepOverrideTask?.lastError.includes('attempt 1/1'), 'task contract maxTimeoutAttempts override should persist the task-level attempt budget');
  assert(contractSweepOverrideLog?.payload?.maxAttempts === 1, 'task contract maxTimeoutAttempts override should reach the timeout log payload');
  assert(contractSweepOverrideLog?.payload?.lastError.includes('Task contract timeout reason override.'), 'task contract timeoutReason override should reach the timeout log payload');

  let exhaustedAttempts = 0;
  const exhaustedRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    runnerId: 'runner-retry-exhausted',
    maxTaskRetries: 2,
    adapter: async ({ task }) => {
      exhaustedAttempts += 1;
      throw new Error(`持续失败：${task.title}#${exhaustedAttempts}`);
    }
  });

  const exhaustedWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 runner 会在重试预算耗尽后阻塞',
    plan: markTestPlan({
      goal: '验证 runner 会在重试预算耗尽后阻塞',
      steps: [
        {
          key: 'retry-exhausted',
          title: '持续失败直到预算耗尽',
          description: '每次执行都抛错，直到 runner 阻塞任务'
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const exhaustedSteps = [];
  for (let index = 0; index < 3; index += 1) {
    exhaustedSteps.push(await exhaustedRunner.runOnce());
  }
  const exhaustedState = engine.getWorkflowState({ workflowId: exhaustedWorkflow.workflow.workflowId });
  const exhaustedTask = exhaustedState.tasks[0];

  const exhaustedErrorLog = [...exhaustedState.runLogs].reverse().find((log) => log.taskId === exhaustedTask.taskId && log.action === 'task_runner_error') || null;

  assert(exhaustedSteps[0].status === 'ready', 'first exhausted attempt should be rescheduled');
  assert(exhaustedSteps[1].status === 'ready', 'second exhausted attempt should still be rescheduled within budget');
  assert(exhaustedSteps[2].status === 'blocked', 'retry exhaustion should finally block the task');
  assert(exhaustedTask.status === 'blocked', 'exhausted task should persist as blocked');
  assert(exhaustedTask.attemptCount === 3, 'attempt count should match total claims through budget exhaustion');
  assert(exhaustedTask.lastError === `持续失败：${exhaustedTask.title}#3`, 'lastError should keep the final thrown error after exhaustion');
  assert(exhaustedTask.reasonCode === 'runner_execution_failed', 'exhausted task should persist the terminal execution reason code');
  assert(exhaustedErrorLog?.payload?.recovery?.reasonCode === 'runner_execution_failed', 'task_runner_error log should store the terminal execution reason code');
  assert(exhaustedState.runLogs.filter((log) => log.action === 'task_retry_scheduled_by_runner').length >= 2, 'exhausted flow should write retry scheduling logs before blocking');
  assert(exhaustedState.runLogs.some((log) => log.action === 'task_runner_error'), 'exhausted flow should end with task_runner_error');

  const verifierTerminalRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    runnerId: 'runner-verifier-terminal',
    maxTaskRetries: 2,
    adapter: async ({ task }) => ({
      status: 'done',
      doneSummary: `产出结果：${task.title}`,
      payload: {
        taskId: task.taskId
      }
    }),
    verifier: async () => ({
      status: 'failed',
      reason: '验证失败，不应自动重试。'
    })
  });

  const verifierTerminalWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 verifier failed 不会触发自动重试',
    plan: markTestPlan({
      goal: '验证 verifier failed 不会触发自动重试',
      steps: [
        {
          key: 'verifier-terminal',
          title: '验证失败直接终态阻塞',
          description: 'adapter done 但 verifier failed 时不自动重试'
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const verifierTerminalStep = await verifierTerminalRunner.runOnce();
  const verifierTerminalState = engine.getWorkflowState({ workflowId: verifierTerminalWorkflow.workflow.workflowId });
  const verifierTerminalTask = verifierTerminalState.tasks[0];

  const verifierTerminalHandoff = verifierTerminalStep.handoff || verifierTerminalTask.handoff;

  assert(verifierTerminalStep.status === 'blocked', 'verifier failure should remain terminal');
  assert(verifierTerminalTask.status === 'blocked', 'verifier failure should persist as blocked');
  assert(verifierTerminalHandoff?.summary === '验证失败，不应自动重试。', 'verifier failure should refresh the handoff summary to the latest blocked reason');
  assert(!verifierTerminalState.runLogs.some((log) => log.action === 'task_retry_scheduled_by_runner'), 'verifier failure should not schedule retry');

  const blockedRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    runnerId: 'runner-blocked',
    adapter: async ({ task, prompt, contextSnapshot, contextItems }) => ({
      status: 'blocked',
      blockedReason: `等待处理：${task.title}`,
      payload: {
        blockedTaskId: task.taskId,
        promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
        contextSnapshotId: contextSnapshot?.snapshotId || null,
        contextItemKinds: contextItems.map((item) => item.kind)
      }
    })
  });


  const blockedWorkflow = engine.createWorkflowFromInstruction({
    instruction: '修复会被阻塞的工作流',
    plan: markTestPlan(draftInitialPlan('修复会被阻塞的工作流'), 'runner-smoke-test')
  });
  const blockedResult = await blockedRunner.runOnce();
  const blockedState = engine.getWorkflowState({ workflowId: blockedWorkflow.workflow.workflowId });
  const blockedTask = blockedState.tasks.find((task) => task.taskId === blockedResult.task.taskId);

  assert(blockedResult.status === 'blocked', 'runner should return blocked when adapter reports blocked');
  assert(blockedState.workflow.status === 'blocked', 'workflow should become blocked after runner reports blocked');
  assert(blockedTask?.status === 'blocked', 'blocked task should be persisted');
  assert(blockedTask?.lastError === blockedTask.blockedReason, 'blocked task should persist lastError');
  assert(blockedState.runLogs.some((log) => log.action === 'task_blocked_by_runner'), 'runner blocked log should exist');
  assert(blockedResult.contextSnapshot?.snapshotId, 'blocked result should expose contextSnapshot');
  assert(Array.isArray(blockedResult.contextItems) && blockedResult.contextItems.length >= 1, 'blocked result should expose contextItems');
  assert(!blockedResult.prompt.includes('相关上下文：'), 'blocked prompt should omit broad context section by default');
  assert(blockedResult.adapterPayload?.promptHasContextSection === false, 'blocked adapter payload should reflect that no extra context section was injected on first attempt');
  assert(blockedResult.adapterPayload?.contextSnapshotId === blockedResult.contextSnapshot.snapshotId, 'adapter payload should receive the same context snapshot id');
  assert(blockedResult.adapterPayload?.contextItemKinds.includes('current-task'), 'context bundle should include the current task item');

  const blockedTaskSourceRef = createWorkflowTaskSourceRef(blockedWorkflow.workflow.workflowId, blockedTask.taskId);
  const blockedContextItems = contextSystem.queryItems({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: blockedWorkflow.workflow.workflowId,
    taskId: blockedTask.taskId,
    sourceKind: 'workflow-task',
    sourceRef: blockedTaskSourceRef,
    limit: 5
  });
  const blockedSnapshots = contextSystem.querySnapshots({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: blockedWorkflow.workflow.workflowId,
    taskId: blockedTask.taskId,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: blockedTaskSourceRef,
    limit: 20
  });

  assert(blockedContextItems.total === 1, 'blocked task should create one lifecycle context item');
  assert(blockedContextItems.items[0].summary.includes('等待处理'), 'blocked task context should record the blocked reason');
  assert(blockedContextItems.items[0].metadata.kind === 'blocked', 'blocked task context metadata should record blocked kind');
  assert(blockedContextItems.items[0].metadata.contextSnapshotId === blockedResult.contextSnapshot.snapshotId, 'blocked task context should store the snapshot id');
  assert(blockedSnapshots.total === 1, 'first blocked attempt should create one snapshot');
  assert(blockedSnapshots.items[0].items.some((item) => item.kind === 'current-task'), 'blocked snapshot should retain current task context');

  const resumedTask = engine.advanceTaskStatus({
    workflowId: blockedWorkflow.workflow.workflowId,
    taskId: blockedTask.taskId,
    status: 'ready',
    blockedReason: null,
    lastError: blockedTask.lastError,
    action: 'task_resumed_by_smoke_test',
    message: '恢复阻塞任务'
  }).task;
  const resumedContextItem = contextSystem.updateItem({
    contextId: blockedContextItems.items[0].contextId,
    summary: `Task "${blockedTask.title}" resumed and is ready to retry.`,
    content: [
      `workflowId: ${blockedWorkflow.workflow.workflowId}`,
      `taskId: ${blockedTask.taskId}`,
      `taskTitle: ${blockedTask.title}`,
      `taskStatus: ${resumedTask.status}`,
      `previousStatus: ${blockedTask.status}`,
      `blockedReason: ${blockedTask.blockedReason || '无'}`,
      `lastError: ${blockedTask.lastError || '无'}`,
      'resumeMessage: 恢复阻塞任务',
      'resumePayload: {"operator":"smoke-test"}'
    ].join('\n'),
    metadata: {
      kind: 'resumed',
      previousStatus: blockedTask.status,
      blockedReason: blockedTask.blockedReason,
      lastError: blockedTask.lastError,
      resumeMessage: '恢复阻塞任务',
      resumePayload: { operator: 'smoke-test' },
      resumedTaskId: blockedTask.taskId
    },
    priority: 95
  }).item;

  const retriedResult = await blockedRunner.runOnce();

  assert(resumedTask.status === 'ready', 'manual resume should move the task back to ready');
  assert(resumedTask.attemptCount === blockedTask.attemptCount, 'manual resume should preserve historical attemptCount before retrying');
  assert(resumedContextItem.metadata.resumeMessage === '恢复阻塞任务', 'manual resume context should persist resume message');
  assert(retriedResult.handoff?.summary === `等待处理：${blockedTask.title}`, 'retry should refresh the handoff summary to the latest blocked reason');
  assert(retriedResult.prompt.includes('恢复信息：'), 'retried prompt should surface the resume hint section');
  assert(retriedResult.contextSnapshot?.metadata?.hasResumeHint === true, 'retried snapshot metadata should record resume hint selection');
  assert(retriedResult.contextSnapshot?.metadata?.selectedReasons.includes('resume-message'), 'retried snapshot metadata should record why resume hint was selected');
  assert(retriedResult.contextItems.some((item) => item.kind === 'resume-hint'), 'retried context bundle should include a resume-hint item');

  const retriedSnapshots = contextSystem.querySnapshots({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: blockedWorkflow.workflow.workflowId,
    taskId: blockedTask.taskId,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: blockedTaskSourceRef,
    limit: 20
  });
  assert(retriedSnapshots.total === 2, 'retry should append another auditable snapshot');
  assert(retriedSnapshots.items.some((snapshot) => snapshot.content.includes('最近错误 / 阻塞：')), 'retry snapshots should preserve the last-error section');
  assert(retriedSnapshots.items.some((snapshot) => snapshot.content.includes('恢复信息：')), 'retry snapshots should render the resume hint section');
  assert(retriedSnapshots.items.some((snapshot) => snapshot.metadata?.hasResumeHint === true), 'retry snapshots should persist resume hint metadata');
  assert(retriedSnapshots.items.some((snapshot) => snapshot.items.some((item) => item.kind === 'resume-hint')), 'retry snapshots should persist the resume-hint item');

  const noisyWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证高噪音上下文下也能保留恢复提示',
    plan: markTestPlan(draftInitialPlan('验证高噪音上下文下也能保留恢复提示'), 'runner-smoke-test')
  });
  const noisyTask = noisyWorkflow.tasks[0];
  const noisyTaskSourceRef = createWorkflowTaskSourceRef(noisyWorkflow.workflow.workflowId, noisyTask.taskId);

  const resumedNoisyItem = contextSystem.writeItem({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'runner-smoke-test',
    kind: 'workflow-task-lifecycle',
    workflowId: noisyWorkflow.workflow.workflowId,
    taskId: noisyTask.taskId,
    sourceKind: 'workflow-task',
    sourceRef: noisyTaskSourceRef,
    title: `Workflow task ${noisyTask.title}`,
    summary: `Task "${noisyTask.title}" resumed and is ready to retry.`,
    content: [
      `workflowId: ${noisyWorkflow.workflow.workflowId}`,
      `taskId: ${noisyTask.taskId}`,
      `taskTitle: ${noisyTask.title}`,
      'taskStatus: ready',
      'previousStatus: blocked',
      'blockedReason: 上一次执行被阻塞',
      'lastError: 上一次执行被阻塞',
      'resumeMessage: 即使有很多噪音也要保留这条恢复提示',
      'resumePayload: {"operator":"noise-test"}'
    ].join('\n'),
    metadata: {
      kind: 'resumed',
      previousStatus: 'blocked',
      blockedReason: '上一次执行被阻塞',
      lastError: '上一次执行被阻塞',
      resumeMessage: '即使有很多噪音也要保留这条恢复提示',
      resumePayload: { operator: 'noise-test' },
      resumedTaskId: noisyTask.taskId
    },
    priority: 95
  }).item;

  for (let index = 0; index < 12; index += 1) {
    contextSystem.writeItem({
      scope: 'workspace',
      projectKey: 'workflow-closure',
      workspacePath: 'C:/workspace/workflow-closure',
      sessionId: 'runner-smoke-test',
      kind: 'workflow-task-lifecycle',
      workflowId: noisyWorkflow.workflow.workflowId,
      taskId: `noise-task-${index}`,
      sourceKind: 'workflow-task',
      sourceRef: createWorkflowTaskSourceRef(noisyWorkflow.workflow.workflowId, `noise-task-${index}`),      title: `Noise task ${index}`,
      summary: `高优先级噪音 ${index}`,
      content: `noise ${index}`,
      metadata: {
        kind: 'blocked'
      },
      priority: 100 + index
    });
  }

  const noisyRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: noisyWorkflow.workflow.workflowId,
    runnerId: 'runner-noisy',
    adapter: async ({ task, prompt, contextSnapshot, contextItems }) => ({
      status: 'blocked',
      blockedReason: `仍然阻塞：${task.title}`,
      payload: {
        taskId: task.taskId,
        prompt,
        contextSnapshotId: contextSnapshot?.snapshotId || null,
        contextItemKinds: contextItems.map((item) => item.kind)
      }
    })
  });

  const noisyResult = await noisyRunner.runOnce();

  assert(noisyResult.status === 'blocked', 'noisy workflow should still block under the blocking adapter');
  assert(noisyResult.contextItems.some((item) => item.kind === 'resume-hint'), 'current task resume hint should survive workflow-level context noise');
  assert(noisyResult.prompt.includes('恢复信息：'), 'noisy retry prompt should still include the resume hint section');
  assert(noisyResult.prompt.includes('即使有很多噪音也要保留这条恢复提示'), 'noisy retry prompt should preserve the resumed task message');
  assert(noisyResult.contextSnapshot?.metadata?.hasResumeHint === true, 'noisy retry snapshot should still record resume hint metadata');
  assert(noisyResult.contextSnapshot?.items.some((item) => item.kind === 'resume-hint'), 'noisy retry snapshot should persist the resume-hint item');
  assert(noisyResult.contextSnapshot?.items.some((item) => item.metadata?.contextId === resumedNoisyItem.contextId), 'noisy retry snapshot should retain the current task resumed context identity');
  const rerunWrapper = await createAgentWorkflowWrapper({
    dbPath,
    engine,
    context: contextOptions,
    runnerId: 'runner-rerun-wrapper',
    adapter: async ({ task, prompt, contextSnapshot, contextItems }) => ({
      status: 'done',
      doneSummary: `重跑完成：${task.title}`,
      payload: {
        taskId: task.taskId,
        promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
        contextSnapshotId: contextSnapshot?.snapshotId || null,
        contextItemKinds: contextItems.map((item) => item.kind)
      }
    })
  });

  const rerunWorkflow = engine.createWorkflowFromInstruction({
    instruction: '修正错误结论后重新产出结果',
    plan: markTestPlan({
      goal: '修正错误结论后重新产出结果',
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
    }, 'runner-smoke-test')
  });
  const rerunInitialResult = await rerunWrapper.runWorkflow({
    workflowId: rerunWorkflow.workflow.workflowId,
    maxSteps: 20
  });
  assert(rerunInitialResult.status === 'done', 'rerun fixture workflow should finish before restartFromTask');

  const rerunStateBeforeRestart = engine.getWorkflowState({ workflowId: rerunWorkflow.workflow.workflowId });
  const rerunOriginTask = rerunStateBeforeRestart.tasks.find((task) => task.title === '改写错误结论');
  assert(rerunOriginTask, 'rerun fixture should contain the origin task');

  const rerunReason = '中间结论引用了错误上游事实，runner 必须从起点重跑';
  const rerunRestarted = rerunWrapper.restartFromTask({
    workflowId: rerunWorkflow.workflow.workflowId,
    taskId: rerunOriginTask.taskId,
    reason: rerunReason,
    fingerprint: 'runner-rerun-smoke',
    operator: 'smoke-test',
    payload: { operator: 'smoke-test', mode: 'rerun' },
    maxSameFingerprintReruns: 2
  });

  assert(rerunRestarted.task.status === 'ready', 'restartFromTask should move rerun origin back to ready for runner coverage');

  const rerunStepResults = [];
  const rerunRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: rerunWorkflow.workflow.workflowId,
    runnerId: 'runner-rerun',
    adapter: async ({ task, prompt, contextSnapshot, contextItems }) => ({
      status: 'done',
      doneSummary: `runner rerun 完成：${task.title}`,
      payload: {
        taskId: task.taskId,
        prompt,
        promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
        contextSnapshotId: contextSnapshot?.snapshotId || null,
        contextItemKinds: contextItems.map((item) => item.kind)
      }
    })
  });

  let rerunLoopCount = 0;
  let rerunLastResult = null;
  while (rerunLoopCount < 20) {
    rerunLastResult = await rerunRunner.runOnce();
    if (rerunLastResult.status === 'idle') {
      break;
    }
    rerunStepResults.push(rerunLastResult);
    rerunLoopCount += 1;
  }

  const rerunState = engine.getWorkflowState({ workflowId: rerunWorkflow.workflow.workflowId });
  const rerunRetryStep = rerunStepResults.find((step) => step.contextSnapshot?.metadata?.hasRerunHint === true);

  assert(rerunState.workflow.status === 'done', 'runner should finish the rerun workflow after restartFromTask');
  assert(rerunLastResult?.status === 'idle', 'rerun runner loop should finish when no ready tasks remain');
  assert(rerunRetryStep, 'rerun runner should expose a step with rerun hint metadata');
  assert(rerunRetryStep.prompt.includes('恢复信息：'), 'rerun runner step should render the rerun hint section');
  assert(rerunRetryStep.prompt.includes(rerunReason), 'rerun runner step should include the rerun reason');
  assert(rerunRetryStep.contextSnapshot?.metadata?.selectedReasons.includes('rerun-reason'), 'rerun runner snapshot metadata should record why rerun hint was selected');
  assert(rerunRetryStep.contextItems.some((item) => item.kind === 'rerun-hint'), 'rerun runner step should expose the rerun-hint item');
  assert(rerunRetryStep.adapterPayload?.promptHasContextSection === true, 'rerun runner adapter payload should confirm context prompt injection');

  const rerunTaskSourceRef = createWorkflowTaskSourceRef(rerunWorkflow.workflow.workflowId, rerunOriginTask.taskId);
  const rerunTaskSnapshots = contextSystem.querySnapshots({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workflowId: rerunWorkflow.workflow.workflowId,
    taskId: rerunOriginTask.taskId,
    sourceKind: 'workflow-task-snapshot',
    sourceRef: rerunTaskSourceRef,
    limit: 20
  });

  assert(rerunTaskSnapshots.items.some((snapshot) => snapshot.metadata?.hasRerunHint === true), 'rerun runner snapshots should record rerun hint metadata');

  let rerunBoundaryAttempts = 0;
  const rerunBoundaryWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 rerun 会清除旧 reasonCode 但保留 contract',
    plan: markTestPlan({
      goal: '验证 rerun 会清除旧 reasonCode 但保留 contract',
      steps: [
        {
          key: 'rerun-boundary-origin',
          title: '补齐缺失交付物后重跑',
          description: '先触发边界校验阻塞，再通过 restartFromTask 清除旧 reasonCode 并保留 contract',
          contract: {
            requiredArtifacts: ['artifact://required-report']
          }
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const rerunBoundaryRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: rerunBoundaryWorkflow.workflow.workflowId,
    runnerId: 'runner-rerun-boundary',
    adapter: async ({ task }) => {
      rerunBoundaryAttempts += 1;

      if (rerunBoundaryAttempts === 1) {
        return {
          status: 'done',
          doneSummary: `首次缺少交付物：${task.title}`,
          payload: {
            handoff: {
              summary: `handoff：${task.title}`,
              artifacts: []
            }
          }
        };
      }

      return {
        status: 'done',
        doneSummary: `重跑后补齐交付物：${task.title}`,
        payload: {
          handoff: {
            summary: `handoff：${task.title}`,
            artifacts: ['artifact://required-report']
          }
        }
      };
    }
  });

  const rerunBoundaryBlockedStep = await rerunBoundaryRunner.runOnce();
  const rerunBoundaryBlockedState = engine.getWorkflowState({ workflowId: rerunBoundaryWorkflow.workflow.workflowId });
  const rerunBoundaryBlockedTask = rerunBoundaryBlockedState.tasks[0];

  assert(rerunBoundaryBlockedStep.status === 'blocked', 'boundary rerun fixture should block before restartFromTask');
  assert(rerunBoundaryBlockedTask.reasonCode === 'task_boundary_missing_required_artifact', 'boundary rerun fixture should persist the boundary reason code before restart');
  assert(rerunBoundaryBlockedTask.contract?.requiredArtifacts?.includes('artifact://required-report'), 'boundary rerun fixture should persist the original contract before restart');

  const rerunBoundaryRestarted = engine.restartFromTask({
    workflowId: rerunBoundaryWorkflow.workflow.workflowId,
    taskId: rerunBoundaryBlockedTask.taskId,
    reason: '补齐缺失交付物后重新执行',
    fingerprint: 'runner-rerun-boundary-restart',
    operator: 'smoke-test',
    payload: { operator: 'smoke-test', mode: 'rerun-boundary' },
    maxSameFingerprintReruns: 2
  });

  assert(rerunBoundaryRestarted.task.status === 'ready', 'rerun restart should move the blocked task back to ready');
  assert(rerunBoundaryRestarted.task.reasonCode == null, 'rerun restart should clear the old reason code');
  assert(rerunBoundaryRestarted.task.contract?.requiredArtifacts?.includes('artifact://required-report'), 'rerun restart should preserve the original contract');

  const rerunBoundaryDoneStep = await rerunBoundaryRunner.runOnce();
  const rerunBoundaryFinalState = engine.getWorkflowState({ workflowId: rerunBoundaryWorkflow.workflow.workflowId });
  const rerunBoundaryFinalTask = rerunBoundaryFinalState.tasks[0];

  assert(rerunBoundaryDoneStep.status === 'done', 'boundary rerun fixture should succeed after restartFromTask');
  assert(rerunBoundaryFinalTask.status === 'done', 'boundary rerun task should finish after artifacts are restored');
  assert(rerunBoundaryFinalTask.reasonCode == null, 'boundary rerun task should keep reasonCode cleared after success');
  assert(rerunBoundaryFinalTask.contract?.requiredArtifacts?.includes('artifact://required-report'), 'boundary rerun task should keep its contract after success');

  let nestedWorkerPayloadAttempts = 0;
  const nestedWorkerPayloadWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 runner 会回收 nested workerPayload outputs 与 handoff',
    plan: markTestPlan({
      goal: '验证 runner 会回收 nested workerPayload outputs 与 handoff',
      steps: [
        {
          key: 'nested-worker-payload-origin',
          title: '从 nested worker payload 恢复交付物',
          description: '适配器只在 payload.workerPayload 中保留 outputs 与 handoff，runner/verifier 仍应识别。',
          contract: {
            requiredArtifacts: ['artifact://nested-required-report']
          }
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const nestedWorkerPayloadRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: nestedWorkerPayloadWorkflow.workflow.workflowId,
    runnerId: 'runner-nested-worker-payload',
    adapter: async ({ task }) => {
      nestedWorkerPayloadAttempts += 1;
      return {
        status: 'done',
        doneSummary: `nested worker payload 已产出：${task.title}`,
        payload: {
          outputs: [
            {
              kind: 'artifact',
              name: 'top-level-adapter-output',
              contentText: 'top level adapter output',
              metadata: { source: 'adapter-payload' }
            }
          ],
          workerPayload: {
            outputs: [
              {
                kind: 'artifact',
                name: 'nested-required-output',
                contentText: 'nested output content',
                metadata: { source: 'worker-payload' }
              }
            ],
            handoff: {
              summary: `nested-handoff：${task.title}`,
              artifacts: ['artifact://nested-required-report']
            }
          }
        }
      };
    }
  });

  const nestedWorkerPayloadStep = await nestedWorkerPayloadRunner.runOnce();
  const nestedWorkerPayloadState = engine.getWorkflowState({ workflowId: nestedWorkerPayloadWorkflow.workflow.workflowId });
  const nestedWorkerPayloadTask = nestedWorkerPayloadState.tasks[0];
  const nestedWorkerPayloadOutputs = engine.listTaskOutputs({
    workflowId: nestedWorkerPayloadWorkflow.workflow.workflowId,
    taskId: nestedWorkerPayloadTask.taskId,
    limit: 20
  });

  assert(nestedWorkerPayloadAttempts === 1, 'nested worker payload fixture should run once');
  assert(nestedWorkerPayloadStep.status === 'done', 'nested worker payload fixture should succeed');
  assert(nestedWorkerPayloadTask.status === 'done', 'nested worker payload task should finish');
  assert(nestedWorkerPayloadTask.handoff?.summary === `nested-handoff：${nestedWorkerPayloadTask.title}`, 'runner should surface nested workerPayload handoff summary');
  assert(nestedWorkerPayloadTask.handoff?.artifacts?.includes('artifact://nested-required-report'), 'runner should surface nested workerPayload handoff artifacts');
  assert(nestedWorkerPayloadOutputs.some((output) => output.name === 'nested-required-output'), 'runner should persist nested workerPayload outputs');
  assert(nestedWorkerPayloadOutputs.some((output) => output.name === 'top-level-adapter-output'), 'runner should still persist top-level payload outputs');
  assert(nestedWorkerPayloadStep.handoff?.artifacts?.includes('artifact://nested-required-report'), 'runner result should expose nested workerPayload handoff artifacts');

  let leaseLostTakeoverClaim = null;
  const leaseLostWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证旧 runner 在 lease 丢失后不能 finalize',
    plan: markTestPlan(draftInitialPlan('验证旧 runner 在 lease 丢失后不能 finalize'), 'runner-smoke-test')
  });
  const leaseLostRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: leaseLostWorkflow.workflow.workflowId,
    runnerId: 'runner-lease-lost-original',
    leaseMs: 5,
    adapter: async ({ task }) => {
      engine.releaseExpiredTaskLeases({
        now: new Date(Date.now() + 10_000).toISOString(),
        reason: 'Lease expired before finalize in stale runner smoke test.'
      });
      leaseLostTakeoverClaim = engine.claimNextReadyTask({
        workflowId: leaseLostWorkflow.workflow.workflowId,
        leaseOwner: 'runner-lease-lost-takeover',
        leaseMs: 60_000
      });

      return {
        status: 'done',
        doneSummary: `旧 runner 误以为完成：${task.title}`,
        payload: {
          taskId: task.taskId,
          outputs: [
            {
              kind: 'artifact',
              name: 'stale-lease-output',
              contentText: 'stale runner output should not persist',
              metadata: { runnerId: 'runner-lease-lost-original' }
            }
          ]
        }
      };
    }
  });

  const leaseLostStep = await leaseLostRunner.runOnce();
  const leaseLostState = engine.getWorkflowState({ workflowId: leaseLostWorkflow.workflow.workflowId });
  const leaseLostTask = leaseLostState.tasks[0];
  const leaseLostSkipLog = [...leaseLostState.runLogs].reverse().find((log) => log.taskId === leaseLostTask.taskId && log.action === 'task_finalize_skipped_lease_lost') || null;

  assert(leaseLostStep.status === 'idle', 'stale runner should return idle after finalize is skipped for lost lease');
  assert(leaseLostStep.reasonCode === 'lease_lost_before_finalize', 'stale runner should expose lease-lost reasonCode');
  assert(leaseLostTakeoverClaim?.task?.taskId === leaseLostTask.taskId, 'a replacement runner should be able to reclaim the task before stale finalize');
  assert(leaseLostTask.status === 'doing', 'replacement runner claim should keep the task in doing state');
  assert(leaseLostTask.assignmentStatus !== 'assigned' && leaseLostTask.assignmentStatus !== 'accepted', 'replacement runner should not inherit stale active assignment state after lease release');
  assert(leaseLostTask.leaseOwner === 'runner-lease-lost-takeover', 'replacement runner should own the lease after reclaim');
  assert(leaseLostTask.doneSummary == null, 'stale runner should not persist doneSummary after losing the lease');
  assert(leaseLostState.workflow.status !== 'done', 'workflow should not be marked done when stale finalize is skipped');
  assert(leaseLostSkipLog?.payload?.reasonCode === 'lease_lost_before_finalize', 'lease-lost audit log should persist the machine-readable reason');
  assert(!leaseLostState.runLogs.some((log) => log.taskId === leaseLostTask.taskId && log.action === 'task_completed_by_runner'), 'stale runner should not write a completion log after lease loss');

  const leaseLostOutputs = engine.listTaskOutputs({
    workflowId: leaseLostWorkflow.workflow.workflowId,
    taskId: leaseLostTask.taskId,
    limit: 10
  });
  assert(!leaseLostOutputs.some((output) => output.name === 'runner-result' && output.metadata?.runnerId === 'runner-lease-lost-original'), 'stale runner should not persist runner-result output after losing the lease');
  assert(!leaseLostOutputs.some((output) => output.name === 'stale-lease-output'), 'stale runner should not persist explicit payload outputs after losing the lease');

  let leaseLostErrorTakeoverClaim = null;
  const leaseLostErrorWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证旧 runner 在 adapter 报错且 lease 丢失后不能 retry/block',
    plan: markTestPlan(draftInitialPlan('验证旧 runner 在 adapter 报错且 lease 丢失后不能 retry/block'), 'runner-smoke-test')
  });
  const leaseLostErrorRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: leaseLostErrorWorkflow.workflow.workflowId,
    runnerId: 'runner-lease-lost-error-original',
    leaseMs: 5,
    adapter: async () => {
      engine.releaseExpiredTaskLeases({
        now: new Date(Date.now() + 10_000).toISOString(),
        reason: 'Lease expired before adapter-error finalize in stale runner smoke test.'
      });
      leaseLostErrorTakeoverClaim = engine.claimNextReadyTask({
        workflowId: leaseLostErrorWorkflow.workflow.workflowId,
        leaseOwner: 'runner-lease-lost-error-takeover',
        leaseMs: 60_000
      });

      throw new Error('stale adapter failed after losing lease');
    }
  });

  const leaseLostErrorStep = await leaseLostErrorRunner.runOnce();
  const leaseLostErrorState = engine.getWorkflowState({ workflowId: leaseLostErrorWorkflow.workflow.workflowId });
  const leaseLostErrorTask = leaseLostErrorState.tasks[0];
  const leaseLostErrorSkipLog = [...leaseLostErrorState.runLogs].reverse().find((log) => log.taskId === leaseLostErrorTask.taskId && log.action === 'task_finalize_skipped_lease_lost') || null;

  assert(leaseLostErrorStep.status === 'idle', 'stale runner adapter-error path should return idle after lease loss');
  assert(leaseLostErrorStep.reasonCode === 'lease_lost_before_finalize', 'stale runner adapter-error path should expose lease-lost reasonCode');
  assert(leaseLostErrorTakeoverClaim?.task?.taskId === leaseLostErrorTask.taskId, 'a replacement runner should reclaim the adapter-error task before stale finalize');
  assert(leaseLostErrorTask.status === 'doing', 'replacement runner claim should keep the adapter-error task in doing state');
  assert(leaseLostErrorTask.leaseOwner === 'runner-lease-lost-error-takeover', 'replacement runner should own the adapter-error lease after reclaim');
  assert(leaseLostErrorTask.lastError === 'Lease expired before adapter-error finalize in stale runner smoke test.', 'stale adapter error should not overwrite the replacement lease release reason');
  assert(leaseLostErrorSkipLog?.payload?.reasonCode === 'lease_lost_before_finalize', 'adapter-error lease-lost audit log should persist the machine-readable reason');
  assert(!leaseLostErrorState.runLogs.some((log) => log.taskId === leaseLostErrorTask.taskId && log.action === 'task_retry_scheduled_by_runner'), 'stale adapter error should not schedule a retry after lease loss');
  assert(!leaseLostErrorState.runLogs.some((log) => log.taskId === leaseLostErrorTask.taskId && log.action === 'task_runner_error'), 'stale adapter error should not block the task after lease loss');

  const timeoutExhaustedRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    runnerId: 'runner-timeout-exhausted',
    maxTaskRetries: 0,
    taskExecutionTimeoutMs: 20,
    adapter: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { status: 'done', doneSummary: 'should not finalize' };
    }
  });

  const timeoutExhaustedWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证执行超时耗尽后阻塞',
    plan: markTestPlan(draftInitialPlan('验证执行超时耗尽后阻塞'), 'runner-smoke-test')
  });
  const timeoutExhaustedStep = await timeoutExhaustedRunner.runOnce();
  const timeoutExhaustedState = engine.getWorkflowState({ workflowId: timeoutExhaustedWorkflow.workflow.workflowId });
  const timeoutExhaustedTask = timeoutExhaustedState.tasks[0];

  assert(timeoutExhaustedStep.status === 'blocked', 'timeout exhaustion should block the task');
  assert(timeoutExhaustedTask.status === 'blocked', 'timeout-exhausted task should persist as blocked');
  assert(timeoutExhaustedTask.reasonCode === 'runner_execution_timeout', 'timeout-exhausted task should persist timeout reason code');
  assert(timeoutExhaustedState.runLogs.some((log) => log.action === 'task_timeout_by_runner'), 'timeout exhaustion should write timeout block log');

  let autoSweepReleaseAttempts = 0;
  const autoSweepReleaseWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 runner 自动 sweep 超时任务并继续执行',
    plan: markTestPlan(draftInitialPlan('验证 runner 自动 sweep 超时任务并继续执行'), 'runner-smoke-test')
  });
  const autoSweepReleaseClaim = engine.claimNextReadyTask({
    workflowId: autoSweepReleaseWorkflow.workflow.workflowId,
    leaseOwner: 'runner-auto-sweep-release-stale',
    leaseMs: 60_000
  });
  await sleep(40);

  const autoSweepReleaseRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: autoSweepReleaseWorkflow.workflow.workflowId,
    runnerId: 'runner-auto-sweep-release',
    timeoutSweepMaxExecutionMs: 10,
    timeoutSweepMaxAttempts: 2,
    timeoutSweepIntervalMs: 0,
    adapter: async ({ task }) => {
      autoSweepReleaseAttempts += 1;
      return {
        status: 'done',
        doneSummary: `自动 sweep 后完成：${task.title}`,
        payload: {
          taskId: task.taskId,
          autoSweepReleaseAttempts
        }
      };
    }
  });

  const autoSweepReleaseStep = await autoSweepReleaseRunner.runOnce();
  const autoSweepReleaseState = engine.getWorkflowState({ workflowId: autoSweepReleaseWorkflow.workflow.workflowId });
  const autoSweepReleasedTask = autoSweepReleaseState.tasks.find((task) => task.taskId === autoSweepReleaseClaim.task.taskId);

  assert(autoSweepReleaseStep.status === 'done', 'automatic timeout sweep should still let runner complete a released task');
  assert(autoSweepReleaseStep.sweptReleasedTaskCount === 1, 'automatic timeout sweep should report one released task');
  assert(autoSweepReleaseStep.sweptBlockedTaskCount === 0, 'automatic timeout sweep release path should not report blocked tasks');
  assert(autoSweepReleaseAttempts === 1, 'automatic timeout sweep release path should execute adapter exactly once');
  assert(autoSweepReleasedTask?.status === 'done', 'released task should be reclaimed and completed by runner');
  assert(autoSweepReleasedTask?.assignmentStatus !== 'assigned' && autoSweepReleasedTask?.assignmentStatus !== 'accepted', 'released timeout task should not retain stale active assignment state after reclaim and completion');
  assert(autoSweepReleaseState.runLogs.some((log) => log.taskId === autoSweepReleaseClaim.task.taskId && log.action === 'task_timeout_released'), 'automatic timeout sweep should write task_timeout_released log');

  let autoSweepBlockAdapterCalled = false;
  const autoSweepBlockWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 runner 自动 sweep 超时耗尽任务并阻塞',
    plan: markTestPlan(draftInitialPlan('验证 runner 自动 sweep 超时耗尽任务并阻塞'), 'runner-smoke-test')
  });
  const autoSweepBlockClaim = engine.claimNextReadyTask({
    workflowId: autoSweepBlockWorkflow.workflow.workflowId,
    leaseOwner: 'runner-auto-sweep-block-stale',
    leaseMs: 60_000
  });
  await sleep(40);

  const autoSweepBlockRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: autoSweepBlockWorkflow.workflow.workflowId,
    runnerId: 'runner-auto-sweep-block',
    timeoutSweepMaxExecutionMs: 10,
    timeoutSweepMaxAttempts: 1,
    timeoutSweepIntervalMs: 0,
    adapter: async () => {
      autoSweepBlockAdapterCalled = true;
      return {
        status: 'done',
        doneSummary: 'automatic sweep block path should not run adapter'
      };
    }
  });

  const autoSweepBlockStep = await autoSweepBlockRunner.runOnce();
  const autoSweepBlockState = engine.getWorkflowState({ workflowId: autoSweepBlockWorkflow.workflow.workflowId });
  const autoSweepBlockedTask = autoSweepBlockState.tasks.find((task) => task.taskId === autoSweepBlockClaim.task.taskId);

  assert(autoSweepBlockStep.status === 'idle', 'automatic timeout sweep block path should become idle when no ready task remains');
  assert(autoSweepBlockStep.sweptReleasedTaskCount === 0, 'automatic timeout sweep block path should not report released tasks');
  assert(autoSweepBlockStep.sweptBlockedTaskCount === 1, 'automatic timeout sweep block path should report one blocked task');
  assert(autoSweepBlockAdapterCalled === false, 'automatic timeout sweep block path should not execute adapter');
  assert(autoSweepBlockedTask?.status === 'blocked', 'automatic timeout sweep should persist blocked status after max attempts exhaustion');
  assert(autoSweepBlockedTask?.reasonCode === 'runner_execution_timeout', 'automatic timeout sweep block path should persist timeout reason code');
  assert(autoSweepBlockState.runLogs.some((log) => log.taskId === autoSweepBlockClaim.task.taskId && log.action === 'task_timeout_blocked'), 'automatic timeout sweep block path should write task_timeout_blocked log');

  let maintenanceCoexistAttempts = 0;
  const maintenanceTimeoutWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 automatic maintenance 同时处理 timeout sweep',
    plan: markTestPlan(draftInitialPlan('验证 automatic maintenance 同时处理 timeout sweep'), 'runner-smoke-test')
  });
  const maintenanceLeaseWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 automatic maintenance 同时处理 lease release',
    plan: markTestPlan(draftInitialPlan('验证 automatic maintenance 同时处理 lease release'), 'runner-smoke-test')
  });
  const maintenanceTimeoutClaim = engine.claimNextReadyTask({
    workflowId: maintenanceTimeoutWorkflow.workflow.workflowId,
    leaseOwner: 'runner-maintenance-timeout-stale',
    leaseMs: 60_000
  });
  await sleep(30);
  const maintenanceLeaseClaim = engine.claimNextReadyTask({
    workflowId: maintenanceLeaseWorkflow.workflow.workflowId,
    leaseOwner: 'runner-maintenance-lease-stale',
    leaseMs: 5
  });
  await sleep(10);

  const maintenanceCoexistRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    runnerId: 'runner-maintenance-coexist',
    timeoutSweepMaxExecutionMs: 20,
    timeoutSweepMaxAttempts: 2,
    timeoutSweepIntervalMs: 0,
    adapter: async ({ task }) => {
      maintenanceCoexistAttempts += 1;
      return {
        status: 'done',
        doneSummary: `maintenance 协同完成：${task.title}`,
        payload: {
          taskId: task.taskId,
          maintenanceCoexistAttempts
        }
      };
    }
  });

  const maintenanceCoexistStep = await maintenanceCoexistRunner.runOnce();
  const maintenanceTimeoutState = engine.getWorkflowState({ workflowId: maintenanceTimeoutWorkflow.workflow.workflowId });
  const maintenanceLeaseState = engine.getWorkflowState({ workflowId: maintenanceLeaseWorkflow.workflow.workflowId });
  const maintenanceTimeoutTask = maintenanceTimeoutState.tasks.find((task) => task.taskId === maintenanceTimeoutClaim.task.taskId);
  const maintenanceLeaseTask = maintenanceLeaseState.tasks.find((task) => task.taskId === maintenanceLeaseClaim.task.taskId);

  console.log('DEBUG maintenanceCoexistStep:', JSON.stringify({
    status: maintenanceCoexistStep.status,
    sweptReleasedTaskCount: maintenanceCoexistStep.sweptReleasedTaskCount,
    sweptBlockedTaskCount: maintenanceCoexistStep.sweptBlockedTaskCount,
    releasedTaskCount: maintenanceCoexistStep.releasedTaskCount,
    timeoutTaskStatus: maintenanceTimeoutTask?.status,
    timeoutTaskStartedAt: maintenanceTimeoutTask?.startedAt,
    timeoutTaskAttemptCount: maintenanceTimeoutTask?.attemptCount,
    leaseTaskStatus: maintenanceLeaseTask?.status,
    leaseTaskLeaseExpiresAt: maintenanceLeaseTask?.leaseExpiresAt
  }, null, 2));
  assert(maintenanceCoexistStep.status === 'done', 'maintenance should still allow runner to claim and complete a ready task');
  assert(maintenanceCoexistStep.sweptReleasedTaskCount === 1, 'maintenance should report one timeout-swept release');
  assert(maintenanceCoexistStep.releasedTaskCount === 1, 'maintenance should report one expired lease release');
  assert(maintenanceCoexistAttempts === 1, 'maintenance coexist path should execute adapter exactly once');
  assert(maintenanceTimeoutTask?.status !== 'doing', 'timeout-swept task should no longer remain doing after maintenance');
  assert(maintenanceLeaseTask?.status !== 'doing', 'lease-released task should no longer remain doing after maintenance');
  assert(maintenanceTimeoutState.runLogs.some((log) => log.taskId === maintenanceTimeoutClaim.task.taskId && log.action === 'task_timeout_released'), 'maintenance coexist path should keep timeout sweep audit log');
  assert(maintenanceLeaseState.runLogs.some((log) => log.taskId === maintenanceLeaseClaim.task.taskId && log.action === 'task_lease_released'), 'maintenance coexist path should keep lease release audit log');

  const throttleWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 timeout sweep interval 节流',
    plan: markTestPlan({
      goal: '验证 timeout sweep interval 节流',
      steps: [
        {
          key: 'throttle-first',
          title: '首个超时任务',
          description: '第一次 runOnce 应执行 timeout sweep'
        },
        {
          key: 'throttle-second',
          title: '节流窗口内的第二个超时任务',
          description: '第二次 runOnce 因 interval 节流跳过 timeout sweep'
        }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const throttleFirstClaim = engine.claimNextReadyTask({
    workflowId: throttleWorkflow.workflow.workflowId,
    leaseOwner: 'runner-timeout-throttle-first-stale',
    leaseMs: 60_000
  });
  await sleep(40);

  const throttleRunner = await createWorkflowRunner({
    dbPath,
    engine,
    context: contextOptions,
    workflowId: throttleWorkflow.workflow.workflowId,
    runnerId: 'runner-timeout-throttle',
    timeoutSweepMaxExecutionMs: 10,
    timeoutSweepMaxAttempts: 2,
    timeoutSweepIntervalMs: 60_000,
    adapter: async ({ task }) => ({
      status: 'done',
      doneSummary: `节流测试完成：${task.title}`,
      payload: {
        taskId: task.taskId
      }
    })
  });

  const throttleFirstStep = await throttleRunner.runOnce();
  const throttleStateAfterFirst = engine.getWorkflowState({ workflowId: throttleWorkflow.workflow.workflowId });
  const throttleRemainingReadyTask = throttleStateAfterFirst.tasks.find((task) => task.status === 'ready');

  assert(throttleFirstStep.sweptReleasedTaskCount === 1, 'first throttled run should still execute timeout sweep');
  assert(throttleRemainingReadyTask, 'throttle fixture should leave one ready task after first run');

  const throttleSecondClaim = engine.claimNextReadyTask({
    workflowId: throttleWorkflow.workflow.workflowId,
    taskId: throttleRemainingReadyTask.taskId,
    leaseOwner: 'runner-timeout-throttle-second-stale',
    leaseMs: 60_000
  });
  await sleep(40);

  const throttleSecondStep = await throttleRunner.runOnce();
  const throttleStateAfterSecond = engine.getWorkflowState({ workflowId: throttleWorkflow.workflow.workflowId });
  const throttleSecondTask = throttleStateAfterSecond.tasks.find((task) => task.taskId === throttleSecondClaim.task.taskId);
  const throttleReleaseLogs = throttleStateAfterSecond.runLogs.filter((log) => log.action === 'task_timeout_released');

  assert(throttleSecondStep.status === 'idle', 'second throttled run should stay idle when sweep is interval-gated and no ready task exists');
  assert(throttleSecondStep.sweptReleasedTaskCount === 0, 'second throttled run should skip timeout sweep within the interval window');
  assert(throttleSecondTask?.status === 'doing', 'interval gating should leave the second stale task untouched in doing state');
  assert(throttleReleaseLogs.length === 1, 'interval gating should avoid duplicate timeout sweep logs during the throttle window');

  const throttleCleanup = engine.releaseExpiredTaskLeases({
    workflowId: throttleWorkflow.workflow.workflowId,
    now: new Date(Date.now() + 120_000).toISOString(),
    reason: 'Cleanup after timeout sweep throttle smoke test.'
  });
  assert(throttleCleanup.releasedTaskCount >= 1, 'throttle cleanup should release the intentionally preserved stale lease');

  const leaseWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 lease 过期任务可被释放',
    plan: markTestPlan(draftInitialPlan('验证 lease 过期任务可被释放'), 'runner-smoke-test')
  });
  const claimed = engine.claimNextReadyTask({
    workflowId: leaseWorkflow.workflow.workflowId,
    leaseOwner: 'runner-lease',
    leaseMs: 5
  });

  const releaseNow = new Date(Date.now() + 10_000).toISOString();
  const released = engine.releaseExpiredTaskLeases({
    now: releaseNow,
    reason: 'Lease expired in runner smoke test.'
  });
  const leaseState = engine.getWorkflowState({ workflowId: leaseWorkflow.workflow.workflowId });
  const releasedTask = leaseState.tasks.find((task) => task.taskId === claimed.task.taskId);
  const leaseReleaseLog = [...leaseState.runLogs].reverse().find((log) => log.taskId === claimed.task.taskId && log.action === 'task_lease_released') || null;

  assert(released.releasedTaskCount >= 1, 'expired lease release should return at least one task');
  assert(releasedTask?.status === 'ready', 'expired lease should move task back to ready');
  assert(releasedTask?.assignmentStatus !== 'assigned' && releasedTask?.assignmentStatus !== 'accepted', 'expired lease should not keep active assignment state');
  assert(releasedTask?.ownerAgentId == null, 'expired lease should clear stale owner agent');
  assert(releasedTask?.leaseOwner == null, 'expired lease should clear lease owner');
  assert(releasedTask?.attemptCount === 1, 'expired lease should preserve the interrupted claim attempt count');
  assert(releasedTask?.lastError === 'Lease expired in runner smoke test.', 'expired lease should persist release reason');
  assert(releasedTask?.reasonCode == null, 'expired lease should clear stale reasonCode when returning to ready');
  assert(leaseReleaseLog?.payload?.previousAttemptCount === 1, 'lease release log should record the pre-release attempt count');
  assert(leaseReleaseLog?.payload?.attemptCount === 1, 'lease release log should record the preserved attempt count');
  assert(leaseState.runLogs.some((log) => log.action === 'task_lease_released'), 'lease release log should exist');

  const peekWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 peek 不污染 workflow 状态',
    plan: markTestPlan({
      goal: '验证 peek 不污染 workflow 状态',
      steps: [
        { key: 'peek-step', title: 'Peek next ready task', type: 'implement' }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const peekTaskBefore = peekWorkflow.tasks[0];
  const peekStateBefore = engine.getWorkflowState({ workflowId: peekWorkflow.workflow.workflowId });
  const peekRunLogCountBefore = peekStateBefore.runLogs.length;
  const peeked = engine.peekNextReadyTask({ workflowId: peekWorkflow.workflow.workflowId });
  const peekStateAfter = engine.getWorkflowState({ workflowId: peekWorkflow.workflow.workflowId });
  const peekTaskAfter = peekStateAfter.tasks.find((task) => task.taskId === peekTaskBefore.taskId);

  assert(peeked?.task?.taskId === peekTaskBefore.taskId, 'peek should return the next ready task');
  assert(peekTaskAfter?.status === 'ready', 'peek should not claim the task');
  assert(peekTaskAfter?.attemptCount === peekTaskBefore.attemptCount, 'peek should not increment attempt count');
  assert(peekTaskAfter?.leaseOwner == null, 'peek should not write lease owner');
  assert(peekStateAfter.runLogs.length === peekRunLogCountBefore, 'peek should not write run logs');
  assert(!peekStateAfter.runLogs.some((log) => log.taskId === peekTaskBefore.taskId && log.action === 'task_claimed'), 'peek should not write task_claimed logs');

  const storageGuardWorkflow = engine.createWorkflowFromInstruction({
    instruction: '验证 storage 入库兜底会隔离原始 upstream 诊断',
    plan: markTestPlan({
      goal: '验证 storage 入库兜底会隔离原始 upstream 诊断',
      steps: [
        { key: 'storage-guard-step', title: 'Storage pollution guard task', type: 'implement' }
      ],
      dependencies: []
    }, 'runner-smoke-test')
  });
  const storageGuardTask = storageGuardWorkflow.tasks[0];
  const rawUpstreamText = 'API Error: 502 {"error":{"message":"Upstream request failed","type":"upstream_error"}}';
  engine.addRunLog({
    workflowId: storageGuardWorkflow.workflow.workflowId,
    taskId: storageGuardTask.taskId,
    action: 'storage_guard_raw_log',
    message: 'Persist raw upstream diagnostic through direct run log API.',
    payload: {
      adapterPayload: {
        adapter: 'claude-code',
        stderr: rawUpstreamText,
        promptHasExecutionContext: true
      },
      stderr: rawUpstreamText
    }
  });
  engine.advanceTaskStatus({
    workflowId: storageGuardWorkflow.workflow.workflowId,
    taskId: storageGuardTask.taskId,
    status: 'blocked',
    blockedReason: 'blocked by storage guard smoke test',
    lastError: rawUpstreamText,
    reasonCode: 'runner_execution_retry',
    recovery: {
      reasonCode: 'runner_execution_retry',
      retryable: true,
      failureType: 'transient',
      error: rawUpstreamText,
      extra: {
        adapterPayload: {
          adapter: 'claude-code',
          stderr: rawUpstreamText
        }
      }
    },
    taskOutputs: [
      {
        kind: 'error',
        name: 'raw-upstream-output',
        content: rawUpstreamText,
        metadata: {
          stderr: rawUpstreamText
        }
      }
    ],
    payload: {
      adapter: 'claude-code',
      stderr: rawUpstreamText,
      promptHasExecutionContext: true
    }
  });
  const storageGuardState = engine.getWorkflowState({ workflowId: storageGuardWorkflow.workflow.workflowId });
  const storageGuardPersistedTask = storageGuardState.tasks.find((task) => task.taskId === storageGuardTask.taskId);
  const storageGuardOutputs = engine.listTaskOutputs({
    workflowId: storageGuardWorkflow.workflow.workflowId,
    taskId: storageGuardTask.taskId
  });
  const storageGuardRunLogText = JSON.stringify(storageGuardState.runLogs);
  const storageGuardOutputText = JSON.stringify(storageGuardOutputs);
  const storageGuardRecoveryText = JSON.stringify(storageGuardPersistedTask?.recovery || {});
  assert(storageGuardRunLogText.includes('Raw Claude/upstream transient diagnostics were quarantined before persistence.'), 'storage guard run logs should keep quarantine summary');
  assert(storageGuardOutputText.includes('Claude upstream 502'), 'storage guard task outputs should keep sanitized upstream summary');
  assert(storageGuardRecoveryText.includes('rawAdapterPayloadQuarantined'), 'storage guard recovery should mark raw adapter payload as quarantined');
  assert(!storageGuardRunLogText.includes('API Error: 502'), 'storage guard run logs should not persist raw API error text');
  assert(!storageGuardRunLogText.includes('Upstream request failed'), 'storage guard run logs should not persist raw upstream JSON text');
  assert(!storageGuardOutputText.includes('API Error: 502'), 'storage guard task outputs should not persist raw API error text');
  assert(!storageGuardOutputText.includes('Upstream request failed'), 'storage guard task outputs should not persist raw upstream JSON text');
  assert(!storageGuardRecoveryText.includes('API Error: 502'), 'storage guard recovery should not persist raw API error text');
  assert(!storageGuardRecoveryText.includes('Upstream request failed'), 'storage guard recovery should not persist raw upstream JSON text');

  console.log('workflow-runner smoke test passed');
  console.log(JSON.stringify({
    completedWorkflowId: completedState.workflow.workflowId,
    completedTaskCount: completedState.tasks.length,
    completedSnapshotCount: completedSnapshots.total,
    blockedWorkflowId: blockedState.workflow.workflowId,
    blockedTaskId: blockedTask?.taskId || null,
    blockedSnapshotCount: retriedSnapshots.total,
    releasedTaskCount: released.releasedTaskCount,
    leaseWorkflowId: leaseState.workflow.workflowId
  }, null, 2));
}

function normalizeWorkspacePathForAssert(value) {
  return value == null
    ? null
    : String(value).replaceAll('\\', '/').toLowerCase();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSemanticTestEmbedder() {
  return {
    embed(text, context = {}) {
      const normalizedText = String(text || '').toLowerCase();

      if (context.kind === 'query') {
        if (normalizedText.includes('实现 runner 自动推进工作流')) {
          return [1, 0];
        }

        return [0, 0];
      }

      if (normalizedText.includes('runner semantic target guidance')) {
        return [1, 0];
      }

      if (normalizedText.includes('runner lexical distractor')) {
        return [0, 1];
      }

      return [0, 0];
    }
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  closeDb();
});
