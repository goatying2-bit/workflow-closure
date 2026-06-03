import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCoordinatorStateView,
  createAgentContextSystem,
  createAgentMemorySystem,
  createAgentWorkflowChain,
  createMultiAgentCoordinator,
  createWorkflowEngine
} from '../index.js';
import { closeDb } from '../storage/db.js';
import { getAgentStore } from '../storage/agents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeDbPath(name) {
  return path.join(__dirname, `pollution-${name}.db`);
}

async function cleanDb(name) {
  const db = makeDbPath(name);
  await fs.rm(db, { force: true });
  return db;
}

async function cleanupDb(db) {
  closeDb(db);
  await fs.rm(db, { force: true });
}

async function testCrossWorkspaceMemoryIsolation() {
  console.log('\n[Test 1] 跨 workspace 记忆隔离...');
  const db = await cleanDb('memory-workspace');

  const memA = await createAgentMemorySystem({ dbPath: db });
  const memB = await createAgentMemorySystem({ dbPath: db });

  memA.remember({
    type: 'fact',
    scope: 'workspace',
    projectKey: 'project-a',
    workspacePath: '/workspace/a',
    content: 'workspace A 的秘密数据'
  });

  memB.remember({
    type: 'fact',
    scope: 'workspace',
    projectKey: 'project-b',
    workspacePath: '/workspace/b',
    content: 'workspace B 的秘密数据'
  });

  const recallA = memA.recall({
    scope: 'workspace',
    projectKey: 'project-a',
    workspacePath: '/workspace/a',
    limit: 10
  });

  const recallB = memB.recall({
    scope: 'workspace',
    projectKey: 'project-b',
    workspacePath: '/workspace/b',
    limit: 10
  });

  const aContents = recallA.items.map(m => m.content);
  const bContents = recallB.items.map(m => m.content);

  assert(aContents.includes('workspace A 的秘密数据'), 'workspace A 应能 recall 自己的记忆');
  assert(!aContents.includes('workspace B 的秘密数据'), 'workspace A 不应看到 workspace B 的记忆');
  assert(bContents.includes('workspace B 的秘密数据'), 'workspace B 应能 recall 自己的记忆');
  assert(!bContents.includes('workspace A 的秘密数据'), 'workspace B 不应看到 workspace A 的记忆');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testCrossWorkspaceContextIsolation() {
  console.log('\n[Test 2] 跨 workspace 上下文隔离...');
  const db = await cleanDb('context-workspace');

  const ctxA = await createAgentContextSystem({ dbPath: db });
  const ctxB = await createAgentContextSystem({ dbPath: db });

  ctxA.writeItem({
    kind: 'note',
    scope: 'workspace',
    projectKey: 'project-a',
    workspacePath: '/workspace/a',
    content: 'workspace A 的上下文'
  });

  ctxB.writeItem({
    kind: 'note',
    scope: 'workspace',
    projectKey: 'project-b',
    workspacePath: '/workspace/b',
    content: 'workspace B 的上下文'
  });

  const resultA = ctxA.queryItems({
    scope: 'workspace',
    projectKey: 'project-a',
    workspacePath: '/workspace/a'
  });

  const resultB = ctxB.queryItems({
    scope: 'workspace',
    projectKey: 'project-b',
    workspacePath: '/workspace/b'
  });

  const aContents = resultA.items.map(c => c.content);
  const bContents = resultB.items.map(c => c.content);

  assert(aContents.includes('workspace A 的上下文'), 'workspace A 应能查到自己的上下文');
  assert(!aContents.includes('workspace B 的上下文'), 'workspace A 不应看到 workspace B 的上下文');
  assert(bContents.includes('workspace B 的上下文'), 'workspace B 应能查到自己的上下文');
  assert(!bContents.includes('workspace A 的上下文'), 'workspace B 不应看到 workspace A 的上下文');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testSessionMemoryIsolation() {
  console.log('\n[Test 3] 跨 session 记忆隔离...');
  const db = await cleanDb('memory-session');

  const mem = await createAgentMemorySystem({ dbPath: db });

  mem.remember({
    type: 'fact',
    scope: 'session',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    sessionId: 'session-1',
    content: 'session-1 的临时数据'
  });

  mem.remember({
    type: 'fact',
    scope: 'session',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    sessionId: 'session-2',
    content: 'session-2 的临时数据'
  });

  const recall1 = mem.recall({
    scope: 'session',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    sessionId: 'session-1',
    limit: 10
  });

  const recall2 = mem.recall({
    scope: 'session',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    sessionId: 'session-2',
    limit: 10
  });

  const contents1 = recall1.items.map(m => m.content);
  const contents2 = recall2.items.map(m => m.content);

  assert(contents1.includes('session-1 的临时数据'), 'session-1 应能 recall 自己的数据');
  assert(!contents1.includes('session-2 的临时数据'), 'session-1 不应看到 session-2 的数据');
  assert(contents2.includes('session-2 的临时数据'), 'session-2 应能 recall 自己的数据');
  assert(!contents2.includes('session-1 的临时数据'), 'session-2 不应看到 session-1 的数据');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testScopeNarrowing() {
  console.log('\n[Test 4] scope 收窄 - workspace 到 session...');
  const db = await cleanDb('memory-scope');

  const mem = await createAgentMemorySystem({ dbPath: db });

  mem.remember({
    type: 'fact',
    scope: 'workspace',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    content: 'workspace 级别的事实'
  });

  mem.remember({
    type: 'fact',
    scope: 'session',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    sessionId: 'session-1',
    content: 'session 级别的事实'
  });

  const workspaceRecall = mem.recall({
    scope: 'workspace',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    limit: 10
  });

  const sessionRecall = mem.recall({
    scope: 'session',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    sessionId: 'session-1',
    limit: 10
  });

  const wsContents = workspaceRecall.items.map(m => m.content);
  const sContents = sessionRecall.items.map(m => m.content);

  assert(wsContents.includes('workspace 级别的事实'), 'workspace scope 应看到 workspace 级别数据');
  assert(!wsContents.includes('session 级别的事实'), 'workspace scope 不应看到 session 级别数据');

  assert(sContents.includes('session 级别的事实'), 'session scope 应看到 session 级别数据');
  assert(!sContents.includes('workspace 级别的事实'), 'session scope 不应看到 workspace 级别数据');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testRerunResidualData() {
  console.log('\n[Test 5] rerun 后残留数据检查...');
  const db = await cleanDb('rerun-residual');

  const engine = await createWorkflowEngine({ dbPath: db });

  const created = engine.createWorkflowFromInstruction({
    instruction: 'rerun 残留测试',
    plan: {
      goal: 'rerun 残留',
      steps: [
        { key: 's1', title: '任务1', type: 'implement' },
        { key: 's2', title: '任务2', type: 'implement' },
        { key: 's3', title: '任务3', type: 'implement' }
      ],
      dependencies: [
        { from: 's1', to: 's2' },
        { from: 's2', to: 's3' }
      ]
    }
  });

  const wfId = created.workflow.workflowId;

  let task = engine.getNextTask({ workflowId: wfId });
  engine.advanceTaskStatus({ workflowId: wfId, taskId: task.taskId, status: 'doing' });
  engine.advanceTaskStatus({
    workflowId: wfId, taskId: task.taskId, status: 'done',
    doneSummary: '任务1第一次完成', message: '第一次'
  });

  task = engine.getNextTask({ workflowId: wfId });
  const task2Id = task.taskId;
  engine.advanceTaskStatus({ workflowId: wfId, taskId: task2Id, status: 'doing' });
  engine.advanceTaskStatus({
    workflowId: wfId, taskId: task2Id, status: 'blocked',
    blockedReason: '任务2被阻塞', lastError: '任务2被阻塞'
  });

  const stateBeforeRerun = engine.getWorkflowState({ workflowId: wfId });
  const task2Before = stateBeforeRerun.tasks.find(t => t.taskId === task2Id);
  assert(task2Before.doneSummary === null, 'blocked 任务不应有 doneSummary');
  assert(task2Before.blockedReason === '任务2被阻塞', 'blocked 任务应有 blockedReason');

  engine.restartFromTask({
    workflowId: wfId,
    taskId: task2Id,
    reason: '重跑测试'
  });

  const stateAfterRerun = engine.getWorkflowState({ workflowId: wfId });
  const task2After = stateAfterRerun.tasks.find(t => t.taskId === task2Id);
  const task3After = stateAfterRerun.tasks.find(t => t.title === '任务3');

  assert(task2After.status === 'ready', `任务2 rerun 后应为 ready，实际 ${task2After.status}`);
  assert(task2After.doneSummary === null, '任务2 rerun 后 doneSummary 应被清除');
  assert(task2After.blockedReason === null, '任务2 rerun 后 blockedReason 应被清除');
  assert(task2After.lastError !== null, '任务2 rerun 后 lastError 应保留重跑原因');
  assert(task2After.attemptCount === 0, '任务2 rerun 后 attemptCount 应为 0');
  assert(task2After.leaseOwner === null, '任务2 rerun 后 leaseOwner 应为 null');
  assert(task2After.leaseExpiresAt === null, '任务2 rerun 后 leaseExpiresAt 应为 null');

  assert(task3After.status === 'pending', `任务3 rerun 后应为 pending，实际 ${task3After.status}`);
  assert(task3After.doneSummary === null, '任务3 rerun 后 doneSummary 应被清除');

  const task1After = stateAfterRerun.tasks.find(t => t.title === '任务1');
  assert(task1After.status === 'done', '任务1 不在 rerun 范围内，应保持 done');
  assert(task1After.doneSummary === '任务1第一次完成', '任务1 的 doneSummary 不应被清除');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testRerunRunLogIntegrity() {
  console.log('\n[Test 6] rerun 后 runLog 完整性...');
  const db = await cleanDb('rerun-log');

  const engine = await createWorkflowEngine({ dbPath: db });

  const created = engine.createWorkflowFromInstruction({
    instruction: 'rerun log 测试',
    plan: {
      goal: 'rerun log',
      steps: [
        { key: 's1', title: '任务1', type: 'implement' },
        { key: 's2', title: '任务2', type: 'implement' }
      ],
      dependencies: [{ from: 's1', to: 's2' }]
    }
  });

  const wfId = created.workflow.workflowId;

  let task = engine.getNextTask({ workflowId: wfId });
  engine.advanceTaskStatus({ workflowId: wfId, taskId: task.taskId, status: 'doing' });
  engine.advanceTaskStatus({
    workflowId: wfId, taskId: task.taskId, status: 'done',
    doneSummary: '完成1'
  });

  const logsBeforeRerun = engine.getWorkflowState({ workflowId: wfId }).runLogs;
  const logCountBefore = logsBeforeRerun.length;

  engine.restartFromTask({
    workflowId: wfId,
    taskId: task.taskId,
    reason: 'log 完整性测试'
  });

  const logsAfterRerun = engine.getWorkflowState({ workflowId: wfId }).runLogs;
  const rerunLog = logsAfterRerun.find(l => l.action === 'task_rerun_requested');

  assert(rerunLog, 'rerun 应产生 task_rerun_requested 日志');
  assert(logsAfterRerun.length > logCountBefore, 'rerun 后 runLog 数量应增加');

  const originalLogsStillPresent = logsBeforeRerun.every(originalLog =>
    logsAfterRerun.some(l => l.logId === originalLog.logId)
  );
  assert(originalLogsStillPresent, 'rerun 不应删除原有 runLog');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testRerunRevisionIntegrity() {
  console.log('\n[Test 7] rerun 后 revision 记录完整性...');
  const db = await cleanDb('rerun-revision');

  const engine = await createWorkflowEngine({ dbPath: db });

  const created = engine.createWorkflowFromInstruction({
    instruction: 'rerun revision 测试',
    plan: {
      goal: 'rerun revision',
      steps: [
        { key: 's1', title: '任务1', type: 'implement' },
        { key: 's2', title: '任务2', type: 'implement' }
      ],
      dependencies: [{ from: 's1', to: 's2' }]
    }
  });

  const wfId = created.workflow.workflowId;

  let task = engine.getNextTask({ workflowId: wfId });
  engine.advanceTaskStatus({ workflowId: wfId, taskId: task.taskId, status: 'doing' });
  engine.advanceTaskStatus({
    workflowId: wfId, taskId: task.taskId, status: 'done',
    doneSummary: '原始完成'
  });

  task = engine.getNextTask({ workflowId: wfId });
  engine.advanceTaskStatus({ workflowId: wfId, taskId: task.taskId, status: 'doing' });
  engine.advanceTaskStatus({
    workflowId: wfId, taskId: task.taskId, status: 'done',
    doneSummary: '任务2完成'
  });

  engine.restartFromTask({
    workflowId: wfId,
    taskId: task.taskId,
    reason: 'revision 测试'
  });

  const revisions = engine.listTaskRevisions({ workflowId: wfId, taskId: task.taskId });
  assert(revisions.length >= 1, 'rerun 应产生至少一条 revision');

  const latestRevision = revisions[revisions.length - 1];
  assert(latestRevision.previousStatus === 'done', `revision 应记录之前状态 done，实际 ${latestRevision.previousStatus}`);
  assert(latestRevision.previousDoneSummary === '任务2完成', 'revision 应记录之前的 doneSummary');

  const reruns = engine.listWorkflowReruns({ workflowId: wfId });
  assert(reruns.length >= 1, 'rerun 应产生 rerun 记录');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testCrossChainStageIsolation() {
  console.log('\n[Test 8] 跨 chain 阶段隔离...');
  const db = await cleanDb('chain-isolation');

  const engine = await createWorkflowEngine({ dbPath: db });
  const chain = await createAgentWorkflowChain({
    dbPath: db,
    engine,
    adapter: async ({ task }) => ({
      status: 'done',
      doneSummary: `完成：${task.title}`
    })
  });

  const chain1 = chain.createChain({
    instruction: 'chain-1 指令',
    stages: [
      { title: 'chain1-阶段1', instruction: 'c1s1' },
      { title: 'chain1-阶段2', instruction: 'c1s2' }
    ]
  });

  const chain2 = chain.createChain({
    instruction: 'chain-2 指令',
    stages: [
      { title: 'chain2-阶段1', instruction: 'c2s1' },
      { title: 'chain2-阶段2', instruction: 'c2s2' }
    ]
  });

  assert(chain1.chain.chainId !== chain2.chain.chainId, '两个 chain 应有不同 ID');

  const state1 = chain.getChainState({ chainId: chain1.chain.chainId });
  const state2 = chain.getChainState({ chainId: chain2.chain.chainId });

  const stage1Ids = state1.stages.map(s => s.stageId);
  const stage2Ids = state2.stages.map(s => s.stageId);
  const overlap = stage1Ids.filter(id => stage2Ids.includes(id));
  assert(overlap.length === 0, '两个 chain 的 stage 不应有重叠 ID');

  const stage1Titles = state1.stages.map(s => s.title);
  const stage2Titles = state2.stages.map(s => s.title);
  assert(!stage1Titles.includes('chain2-阶段1'), 'chain1 不应包含 chain2 的阶段');
  assert(!stage2Titles.includes('chain1-阶段1'), 'chain2 不应包含 chain1 的阶段');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testCrossWorkflowTaskIsolation() {
  console.log('\n[Test 9] 跨 workflow 任务完全隔离...');
  const db = await cleanDb('workflow-isolation');

  const engine = await createWorkflowEngine({ dbPath: db });

  const w1 = engine.createWorkflowFromInstruction({
    instruction: 'workflow-1',
    plan: {
      goal: 'w1',
      steps: [
        { key: 's1', title: 'w1-任务1', type: 'implement' },
        { key: 's2', title: 'w1-任务2', type: 'implement' }
      ],
      dependencies: [{ from: 's1', to: 's2' }]
    }
  });

  const w2 = engine.createWorkflowFromInstruction({
    instruction: 'workflow-2',
    plan: {
      goal: 'w2',
      steps: [
        { key: 's1', title: 'w2-任务1', type: 'implement' },
        { key: 's2', title: 'w2-任务2', type: 'implement' }
      ],
      dependencies: [{ from: 's1', to: 's2' }]
    }
  });

  const state1 = engine.getWorkflowState({ workflowId: w1.workflow.workflowId });
  const state2 = engine.getWorkflowState({ workflowId: w2.workflow.workflowId });

  const task1Ids = state1.tasks.map(t => t.taskId);
  const task2Ids = state2.tasks.map(t => t.taskId);
  const idOverlap = task1Ids.filter(id => task2Ids.includes(id));
  assert(idOverlap.length === 0, '两个 workflow 的任务 ID 不应重叠');

  const dep1Pairs = state1.dependencies.map(d => `${d.predecessorTaskId}->${d.successorTaskId}`);
  const dep2Pairs = state2.dependencies.map(d => `${d.predecessorTaskId}->${d.successorTaskId}`);
  const depOverlap = dep1Pairs.filter(d => dep2Pairs.includes(d));
  assert(depOverlap.length === 0, '两个 workflow 的依赖不应重叠');

  const task1 = engine.getNextTask({ workflowId: w1.workflow.workflowId });
  engine.advanceTaskStatus({
    workflowId: w1.workflow.workflowId, taskId: task1.taskId, status: 'doing'
  });

  const state2Untouched = engine.getWorkflowState({ workflowId: w2.workflow.workflowId });
  assert(state2Untouched.workflow.status === 'ready', '操作 w1 不应影响 w2 状态');
  assert(state2Untouched.tasks.every(t => t.status === 'ready' || t.status === 'pending'),
    'w2 的任务状态不应因 w1 的操作而改变');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testMultiAgentAssignmentIsolation() {
  console.log('\n[Test 10] 多 agent 分配隔离...');
  const db = await cleanDb('agent-assignment');

  const engine = await createWorkflowEngine({ dbPath: db });
  const coordinator = await createMultiAgentCoordinator({
    dbPath: db,
    engine,
    agentAdapters: new Map()
  });

  const w1 = engine.createWorkflowFromInstruction({
    instruction: 'agent 隔离测试 w1',
    plan: {
      goal: 'w1',
      steps: [{ key: 's1', title: 'w1任务', type: 'implement' }],
      dependencies: []
    }
  });

  const w2 = engine.createWorkflowFromInstruction({
    instruction: 'agent 隔离测试 w2',
    plan: {
      goal: 'w2',
      steps: [{ key: 's1', title: 'w2任务', type: 'implement' }],
      dependencies: []
    }
  });

  const w1TaskId = w1.tasks[0].taskId;
  const w2TaskId = w2.tasks[0].taskId;

  const dummyAdapter = async () => ({ status: 'done', doneSummary: '完成' });

  coordinator.registerAgent({
    agentId: 'agent-a',
    name: 'Agent A',
    role: 'implementer',
    maxConcurrency: 10,
    status: 'active',
    adapter: dummyAdapter
  });

  coordinator.registerAgent({
    agentId: 'agent-b',
    name: 'Agent B',
    role: 'implementer',
    maxConcurrency: 10,
    status: 'active',
    adapter: dummyAdapter
  });

  const assign1 = await coordinator.assignNextWork({
    workflowId: w1.workflow.workflowId,
    targetType: 'task',
    taskId: w1TaskId,
    agentId: 'agent-a'
  });

  const assign2 = await coordinator.assignNextWork({
    workflowId: w2.workflow.workflowId,
    targetType: 'task',
    taskId: w2TaskId,
    agentId: 'agent-b'
  });

  assert(assign1.assignment.targetId !== assign2.assignment.targetId,
    '不同 workflow 的 assignment 不应指向同一任务');

  assert(assign1.assignment.agentId === 'agent-a', 'w1 任务应分配给 agent-a');
  assert(assign2.assignment.agentId === 'agent-b', 'w2 任务应分配给 agent-b');

  const coordState = coordinator.getCoordinatorState({});
  const assignments = coordState.assignments;
  const w1Assignments = assignments.filter(a => a.workflowId === w1.workflow.workflowId);
  const w2Assignments = assignments.filter(a => a.workflowId === w2.workflow.workflowId);

  assert(w1Assignments.length === 1, 'w1 应只有 1 个 assignment');
  assert(w2Assignments.length === 1, 'w2 应只有 1 个 assignment');
  assert(w1Assignments[0].assignmentId !== w2Assignments[0].assignmentId,
    '不同 workflow 的 assignment ID 不应相同');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testMemoryUpdateDoesNotLeak() {
  console.log('\n[Test 11] 记忆更新不泄漏到其他 workspace...');
  const db = await cleanDb('memory-update-leak');

  const mem = await createAgentMemorySystem({ dbPath: db });

  mem.remember({
    type: 'fact',
    scope: 'workspace',
    projectKey: 'project-a',
    workspacePath: '/workspace/a',
    content: 'A 的原始数据'
  });

  mem.remember({
    type: 'fact',
    scope: 'workspace',
    projectKey: 'project-b',
    workspacePath: '/workspace/b',
    content: 'B 的原始数据'
  });

  const recallA = mem.recall({
    scope: 'workspace',
    projectKey: 'project-a',
    workspacePath: '/workspace/a',
    limit: 10
  });

  const memoryA = recallA.items[0];
  mem.updateMemory({
    memoryId: memoryA.memoryId,
    content: 'A 的更新数据',
    workspacePath: '/workspace/a'
  });

  const recallBAfter = mem.recall({
    scope: 'workspace',
    projectKey: 'project-b',
    workspacePath: '/workspace/b',
    limit: 10
  });

  const bContents = recallBAfter.items.map(m => m.content);
  assert(!bContents.includes('A 的更新数据'), '更新 A 的记忆不应泄漏到 B');
  assert(bContents.includes('B 的原始数据'), 'B 的记忆应保持不变');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testContextSnapshotIsolation() {
  console.log('\n[Test 12] 上下文快照隔离...');
  const db = await cleanDb('context-snapshot');

  const ctx = await createAgentContextSystem({ dbPath: db });

  ctx.writeItem({
    kind: 'note',
    scope: 'workspace',
    projectKey: 'project-a',
    workspacePath: '/workspace/a',
    content: 'A 的上下文项'
  });

  ctx.writeSnapshot({
    scope: 'workspace',
    projectKey: 'project-a',
    workspacePath: '/workspace/a',
    title: 'A 的快照',
    content: 'A 的快照内容',
    items: []
  });

  ctx.writeItem({
    kind: 'note',
    scope: 'workspace',
    projectKey: 'project-b',
    workspacePath: '/workspace/b',
    content: 'B 的上下文项'
  });

  ctx.writeSnapshot({
    scope: 'workspace',
    projectKey: 'project-b',
    workspacePath: '/workspace/b',
    title: 'B 的快照',
    content: 'B 的快照内容',
    items: []
  });

  const snapshotsResultA = ctx.querySnapshots({
    scope: 'workspace',
    projectKey: 'project-a',
    workspacePath: '/workspace/a'
  });

  const snapshotsResultB = ctx.querySnapshots({
    scope: 'workspace',
    projectKey: 'project-b',
    workspacePath: '/workspace/b'
  });

  const aTitles = snapshotsResultA.items.map(s => s.title);
  const bTitles = snapshotsResultB.items.map(s => s.title);

  assert(aTitles.includes('A 的快照'), 'workspace A 应看到自己的快照');
  assert(!aTitles.includes('B 的快照'), 'workspace A 不应看到 B 的快照');
  assert(bTitles.includes('B 的快照'), 'workspace B 应看到自己的快照');
  assert(!bTitles.includes('A 的快照'), 'workspace B 不应看到 A 的快照');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testRerunDoesNotAffectOtherWorkflow() {
  console.log('\n[Test 13] rerun 不影响其他 workflow...');
  const db = await cleanDb('rerun-cross-workflow');

  const engine = await createWorkflowEngine({ dbPath: db });

  const w1 = engine.createWorkflowFromInstruction({
    instruction: 'rerun 隔离 w1',
    plan: {
      goal: 'w1',
      steps: [
        { key: 's1', title: 'w1-任务1', type: 'implement' },
        { key: 's2', title: 'w1-任务2', type: 'implement' }
      ],
      dependencies: [{ from: 's1', to: 's2' }]
    }
  });

  const w2 = engine.createWorkflowFromInstruction({
    instruction: 'rerun 隔离 w2',
    plan: {
      goal: 'w2',
      steps: [
        { key: 's1', title: 'w2-任务1', type: 'implement' },
        { key: 's2', title: 'w2-任务2', type: 'implement' }
      ],
      dependencies: [{ from: 's1', to: 's2' }]
    }
  });

  let task = engine.getNextTask({ workflowId: w1.workflow.workflowId });
  engine.advanceTaskStatus({ workflowId: w1.workflow.workflowId, taskId: task.taskId, status: 'doing' });
  engine.advanceTaskStatus({
    workflowId: w1.workflow.workflowId, taskId: task.taskId, status: 'done',
    doneSummary: 'w1完成'
  });

  task = engine.getNextTask({ workflowId: w2.workflow.workflowId });
  engine.advanceTaskStatus({ workflowId: w2.workflow.workflowId, taskId: task.taskId, status: 'doing' });
  engine.advanceTaskStatus({
    workflowId: w2.workflow.workflowId, taskId: task.taskId, status: 'done',
    doneSummary: 'w2完成'
  });

  const w2StateBeforeRerun = engine.getWorkflowState({ workflowId: w2.workflow.workflowId });

  const w1Task1 = engine.getWorkflowState({ workflowId: w1.workflow.workflowId }).tasks[0];
  engine.restartFromTask({
    workflowId: w1.workflow.workflowId,
    taskId: w1Task1.taskId,
    reason: 'w1 rerun'
  });

  const w2State = engine.getWorkflowState({ workflowId: w2.workflow.workflowId });
  assert(w2State.workflow.status === w2StateBeforeRerun.workflow.status,
    `w1 rerun 不应影响 w2 的 workflow 状态，期望 ${w2StateBeforeRerun.workflow.status}，实际 ${w2State.workflow.status}`);

  const w2DoneTask = w2State.tasks.find(t => t.status === 'done');
  assert(w2DoneTask, 'w2 已完成的任务不应被重置');
  assert(w2DoneTask.doneSummary === 'w2完成', 'w2 的 doneSummary 不应被清除');

  const w2Reruns = engine.listWorkflowReruns({ workflowId: w2.workflow.workflowId });
  assert(w2Reruns.length === 0, 'w1 的 rerun 不应在 w2 的 rerun 列表中产生记录');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testMemoryArchiveDoesNotRecall() {
  console.log('\n[Test 14] 归档记忆不出现在默认 recall 中...');
  const db = await cleanDb('memory-archive');

  const mem = await createAgentMemorySystem({ dbPath: db });

  const created = mem.remember({
    type: 'fact',
    scope: 'workspace',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    content: '即将归档的数据'
  });

  mem.archiveMemory({ memoryId: created.memory.memoryId, reason: '测试归档' });

  const defaultRecall = mem.recall({
    scope: 'workspace',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    limit: 10
  });

  const defaultContents = defaultRecall.items.map(m => m.content);
  assert(!defaultContents.includes('即将归档的数据'), '归档记忆不应出现在默认 recall 中');

  const archivedRecall = mem.recall({
    scope: 'workspace',
    projectKey: 'project-x',
    workspacePath: '/workspace/x',
    statuses: ['archived'],
    limit: 10
  });

  const archivedContents = archivedRecall.items.map(m => m.content);
  assert(archivedContents.includes('即将归档的数据'), '归档记忆应能通过 statuses=archived 召回');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}


async function seedHygieneAssignmentsAndHandoffs({ engine, agentStore, agentId = 'agent-hygiene' }) {
  for (let index = 0; index < 3; index += 1) {
    const polluted = engine.createWorkflowFromInstruction({
      workflowId: `polluted-workflow-${index}`,
      instruction: `admin-ui smoke polluted ${index}`,
      plan: {
        goal: `polluted ${index}`,
        steps: [{ key: 's1', title: 'polluted task', type: 'test' }],
        dependencies: [],
        metadata: {
          dataClass: 'test',
          retention: 'ephemeral',
          generatedBy: 'pollution-stress-test'
        }
      }
    });
    const taskId = polluted.tasks[0].taskId;
    agentStore.createAssignment({
      workflowId: polluted.workflow.workflowId,
      targetType: 'task',
      targetId: taskId,
      agentId,
      status: 'assigned',
      reason: 'polluted assignment'
    });
    agentStore.createHandoff({
      workflowId: polluted.workflow.workflowId,
      sourceType: 'task',
      sourceId: taskId,
      fromAgentId: agentId,
      summary: 'polluted handoff',
      status: 'open'
    });
  }

  const heuristicPolluted = engine.createWorkflowFromInstruction({
    workflowId: 'smoke-heuristic-workflow',
    instruction: 'admin-ui smoke heuristic workflow',
    plan: {
      goal: 'heuristic smoke workflow',
      steps: [{ key: 's1', title: 'heuristic task', type: 'test' }],
      dependencies: []
    }
  });
  const heuristicTaskId = heuristicPolluted.tasks[0].taskId;
  agentStore.createAssignment({
    workflowId: heuristicPolluted.workflow.workflowId,
    targetType: 'task',
    targetId: heuristicTaskId,
    agentId,
    status: 'assigned',
    reason: 'heuristic polluted assignment'
  });
  agentStore.createHandoff({
    workflowId: heuristicPolluted.workflow.workflowId,
    sourceType: 'task',
    sourceId: heuristicTaskId,
    fromAgentId: agentId,
    summary: 'heuristic polluted handoff',
    status: 'open'
  });

  const clean = engine.createWorkflowFromInstruction({
    workflowId: 'clean-workflow-visible-after-pollution',
    instruction: 'real customer workflow',
    plan: {
      goal: 'clean workflow',
      steps: [{ key: 's1', title: 'clean task', type: 'implement' }],
      dependencies: [],
      metadata: {
        dataClass: 'real',
        retention: 'keep',
        generatedBy: 'pollution-stress-test'
      }
    }
  });
  const cleanTaskId = clean.tasks[0].taskId;
  agentStore.createAssignment({
    workflowId: clean.workflow.workflowId,
    targetType: 'task',
    targetId: cleanTaskId,
    agentId,
    status: 'assigned',
    reason: 'clean assignment'
  });
  agentStore.createHandoff({
    workflowId: clean.workflow.workflowId,
    sourceType: 'task',
    sourceId: cleanTaskId,
    fromAgentId: agentId,
    summary: 'clean handoff',
    decisions: ['continue clean workflow'],
    recommendedNextRole: 'implementer',
    status: 'open'
  });

  return { clean, heuristicPolluted };
}

async function testAgentStoreHygieneBeforeLimit() {
  console.log('\n[Test 15] agent store 先过滤污染再限流...');
  const db = await cleanDb('agent-store-hygiene-limit');

  const engine = await createWorkflowEngine({ dbPath: db });
  const coordinator = await createMultiAgentCoordinator({
    dbPath: db,
    engine,
    agentAdapters: new Map()
  });
  const agentStore = getAgentStore({ dbPath: db });

  coordinator.registerAgent({
    agentId: 'agent-hygiene',
    name: 'Hygiene Agent',
    role: 'implementer',
    maxConcurrency: 10,
    status: 'active',
    adapter: async () => ({ status: 'done', doneSummary: '完成' })
  });

  const { clean, heuristicPolluted } = await seedHygieneAssignmentsAndHandoffs({ engine, agentStore });

  const assignments = agentStore.listAssignments({ limit: 1, includeTestData: false });
  const handoffs = agentStore.listHandoffs({ limit: 1, includeTestData: false });

  assert(assignments.length === 1, `默认 store 应返回 1 条 clean assignment，实际 ${assignments.length}`);
  assert(assignments[0].workflowId === clean.workflow.workflowId,
    'store polluted assignment 不应先占用 limit 导致 clean assignment 消失');
  assert(handoffs.length === 1, `默认 store 应返回 1 条 clean handoff，实际 ${handoffs.length}`);
  assert(handoffs[0].workflowId === clean.workflow.workflowId,
    'store polluted handoff 不应先占用 limit 导致 clean handoff 消失');

  const withTestAssignments = agentStore.listAssignments({ limit: 1, includeTestData: true });
  const withTestHandoffs = agentStore.listHandoffs({ limit: 1, includeTestData: true });
  assert(withTestAssignments[0].workflowId !== clean.workflow.workflowId,
    'store includeTestData=true 时应保留原始查询顺序中的测试 assignment');
  assert(withTestHandoffs[0].workflowId !== clean.workflow.workflowId,
    'store includeTestData=true 时应保留原始查询顺序中的测试 handoff');

  const visibleWorkflows = engine.listWorkflows({ limit: 10, includeTestData: false });
  assert(!visibleWorkflows.some((workflow) => workflow.workflowId === heuristicPolluted.workflow.workflowId),
    'heuristic-only workflow 不应出现在默认 workflow list 中');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testCoordinatorStateHygieneBeforeLimit() {
  console.log('\n[Test 16] coordinator 状态先过滤污染再限流...');
  const db = await cleanDb('coordinator-hygiene-limit');

  const engine = await createWorkflowEngine({ dbPath: db });
  const coordinator = await createMultiAgentCoordinator({
    dbPath: db,
    engine,
    agentAdapters: new Map()
  });
  const agentStore = getAgentStore({ dbPath: db });

  coordinator.registerAgent({
    agentId: 'agent-hygiene',
    name: 'Hygiene Agent',
    role: 'implementer',
    maxConcurrency: 10,
    status: 'active',
    adapter: async () => ({ status: 'done', doneSummary: '完成' })
  });

  const { clean } = await seedHygieneAssignmentsAndHandoffs({ engine, agentStore });

  const state = coordinator.getCoordinatorState({
    assignmentQuery: { limit: 1 },
    handoffQuery: { limit: 1 }
  });

  assert(state.assignments.length === 1, `默认状态应返回 1 条 clean assignment，实际 ${state.assignments.length}`);
  assert(state.assignments[0].workflowId === clean.workflow.workflowId,
    'polluted assignment 不应先占用 limit 导致 clean assignment 消失');
  assert(state.handoffs.length === 1, `默认状态应返回 1 条 clean handoff，实际 ${state.handoffs.length}`);
  assert(state.handoffs[0].workflowId === clean.workflow.workflowId,
    'polluted handoff 不应先占用 limit 导致 clean handoff 消失');

  const withTestData = coordinator.getCoordinatorState({
    includeTestData: true,
    assignmentQuery: { limit: 1 },
    handoffQuery: { limit: 1 }
  });

  assert(withTestData.assignments[0].workflowId !== clean.workflow.workflowId,
    'includeTestData=true 时应保留原始查询顺序中的测试 assignment');
  assert(withTestData.handoffs[0].workflowId !== clean.workflow.workflowId,
    'includeTestData=true 时应保留原始查询顺序中的测试 handoff');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function testCompletedTargetOpenHandoffIsHistory() {
  console.log('\n[Test 17] 已完成目标的 open handoff 不算当前 handoff...');
  const db = await cleanDb('completed-target-open-handoff');

  const engine = await createWorkflowEngine({ dbPath: db });
  const coordinator = await createMultiAgentCoordinator({
    dbPath: db,
    engine,
    agentAdapters: new Map()
  });
  const agentStore = getAgentStore({ dbPath: db });

  const created = engine.createWorkflowFromInstruction({
    workflowId: 'completed-target-open-handoff-workflow',
    instruction: 'real customer workflow',
    plan: {
      goal: 'clean workflow',
      steps: [{ key: 's1', title: 'clean task', type: 'implement' }],
      dependencies: [],
      metadata: {
        dataClass: 'real',
        retention: 'keep',
        generatedBy: 'pollution-stress-test'
      }
    }
  });
  const taskId = created.tasks[0].taskId;

  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId,
    status: 'doing'
  });
  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId,
    status: 'done',
    doneSummary: 'done'
  });

  agentStore.createHandoff({
    workflowId: created.workflow.workflowId,
    sourceType: 'task',
    sourceId: taskId,
    summary: 'stale open handoff',
    status: 'open'
  });

  const currentOnlyState = coordinator.getCoordinatorState({ includeHistory: false, handoffQuery: { limit: 10 } });
  const currentOnlyView = buildCoordinatorStateView({ state: currentOnlyState });
  assert(currentOnlyState.handoffs.length === 0,
    `已完成目标的 open handoff 不应出现在 current-only 状态，实际 ${currentOnlyState.handoffs.length}`);
  assert(currentOnlyState.historySummary.currentHandoffCount === 0,
    '已完成目标的 open handoff 不应计入 currentHandoffCount');
  assert(currentOnlyState.historySummary.historyHandoffCount === 1,
    '已完成目标的 open handoff 应计入 historyHandoffCount');
  assert(currentOnlyView.summary.openHandoffCount === 0,
    'current-only 视图的 openHandoffCount 不应包含已完成目标的 open handoff');

  const withHistory = coordinator.getCoordinatorState({ includeHistory: true, handoffQuery: { limit: 10 } });
  assert(withHistory.handoffs.length === 1, 'includeHistory=true 应能看到已完成目标的 open handoff');
  assert(withHistory.handoffs[0].historyKind === 'history', '已完成目标的 open handoff 应归类为 history');
  assert(withHistory.handoffs[0].historyReason === 'handoff_target_finished', 'historyReason 应说明目标已结束');

  await cleanupDb(db);
  console.log('  ✓ 通过');
}

async function main() {
  const tests = [
    testCrossWorkspaceMemoryIsolation,
    testCrossWorkspaceContextIsolation,
    testSessionMemoryIsolation,
    testScopeNarrowing,
    testRerunResidualData,
    testRerunRunLogIntegrity,
    testRerunRevisionIntegrity,
    testCrossChainStageIsolation,
    testCrossWorkflowTaskIsolation,
    testMultiAgentAssignmentIsolation,
    testMemoryUpdateDoesNotLeak,
    testContextSnapshotIsolation,
    testRerunDoesNotAffectOtherWorkflow,
    testMemoryArchiveDoesNotRecall,
    testAgentStoreHygieneBeforeLimit,
    testCoordinatorStateHygieneBeforeLimit,
    testCompletedTargetOpenHandoffIsHistory
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      failed++;
      console.error(`  ✗ 失败: ${error.message}`);
    }
  }

  console.log(`\n========== 数据污染压力测试: ${passed} 通过, ${failed} 失败 ==========`);
  closeDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
