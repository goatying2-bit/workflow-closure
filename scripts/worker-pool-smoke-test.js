import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentContextSystem,
  createAgentWorkflowWrapper,
  createWorkflowEngine,
  createWorkflowWorkerPool
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'worker-pool-smoke-test.db');

async function main() {
  await fs.rm(dbPath, { force: true });

  const engine = await createWorkflowEngine({ dbPath });
  const contextSystem = await createAgentContextSystem({ dbPath });
  const contextOptions = {
    system: contextSystem,
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'worker-pool-smoke-test',
    limit: 6
  };

  await testParallelIndependentTasks(engine, contextOptions);
  await testConcurrencyLimit(engine, contextOptions);
  await testDependencyGate(engine, contextOptions);
  await testBlockedRound(engine, contextOptions);
  await testWrapperWorkerCount(engine, contextOptions);

  console.log('worker-pool smoke test passed');
}

async function testParallelIndependentTasks(engine, contextOptions) {
  const executions = [];
  const created = engine.createWorkflowFromInstruction({
    instruction: 'worker pool 并行执行独立任务',
    concurrencyLimit: 3,
    plan: {
      goal: 'worker pool 并行执行独立任务',
      steps: [
        { key: 'a', title: '并行任务 A', type: 'implement' },
        { key: 'b', title: '并行任务 B', type: 'implement' },
        { key: 'c', title: '并行任务 C', type: 'implement' }
      ],
      dependencies: []
    }
  });
  const pool = await createWorkflowWorkerPool({
    engine,
    workflowId: created.workflow.workflowId,
    workerCount: 3,
    runnerIdPrefix: 'parallel',
    context: contextOptions,
    adapter: async ({ task, runnerId, contextSnapshot }) => {
      const startedAt = Date.now();
      await delay(80);
      const endedAt = Date.now();
      executions.push({ taskId: task.taskId, runnerId, startedAt, endedAt, contextSnapshotId: contextSnapshot?.snapshotId || null });
      return {
        status: 'done',
        doneSummary: `完成 ${task.title}`,
        payload: { runnerId, startedAt, endedAt, contextSnapshotId: contextSnapshot?.snapshotId || null }
      };
    }
  });

  const result = await pool.drain({ maxRounds: 3 });
  const finalState = engine.getWorkflowState({ workflowId: created.workflow.workflowId });
  const doneSteps = result.steps.filter((step) => step.status === 'done');

  assert(result.status === 'done', 'parallel pool should finish independent workflow');
  assert(finalState.tasks.every((task) => task.status === 'done'), 'all independent tasks should be done');
  assert(doneSteps.length === 3, 'three workers should execute three tasks');
  assert(new Set(doneSteps.map((step) => step.runnerId)).size === 3, 'three distinct runner ids should execute tasks');
  assert(new Set(doneSteps.map((step) => step.task?.taskId)).size === 3, 'three distinct tasks should be executed');
  assert(executions.every((item) => item.contextSnapshotId), 'each worker execution should receive a context snapshot');
  assert(hasOverlap(executions), 'worker executions should overlap in time');
}

async function testConcurrencyLimit(engine, contextOptions) {
  const created = engine.createWorkflowFromInstruction({
    instruction: 'worker pool 尊重 workflow concurrencyLimit',
    concurrencyLimit: 2,
    plan: {
      goal: 'worker pool 尊重 workflow concurrencyLimit',
      steps: [
        { key: 'a', title: '限制任务 A', type: 'implement' },
        { key: 'b', title: '限制任务 B', type: 'implement' },
        { key: 'c', title: '限制任务 C', type: 'implement' },
        { key: 'd', title: '限制任务 D', type: 'implement' }
      ],
      dependencies: []
    }
  });
  const pool = await createWorkflowWorkerPool({
    engine,
    workflowId: created.workflow.workflowId,
    workerCount: 4,
    runnerIdPrefix: 'limited',
    context: contextOptions,
    adapter: async ({ task }) => {
      await delay(40);
      return { status: 'done', doneSummary: `完成 ${task.title}` };
    }
  });

  const result = await pool.drain({ maxRounds: 5 });

  assert(result.status === 'done', 'limited pool should finish over multiple rounds');
  assert(result.rounds.every((round) => round.activeCount <= 2), 'no round should execute more tasks than concurrencyLimit');
  assert(result.steps.filter((step) => step.status === 'done').length === 4, 'all limited tasks should eventually complete');
}

async function testDependencyGate(engine, contextOptions) {
  const created = engine.createWorkflowFromInstruction({
    instruction: 'worker pool 保持依赖门控',
    concurrencyLimit: 3,
    plan: {
      goal: 'worker pool 保持依赖门控',
      steps: [
        { key: 'a', title: '前置任务 A', type: 'implement' },
        { key: 'b', title: '前置任务 B', type: 'implement' },
        { key: 'c', title: '后继任务 C', type: 'implement' }
      ],
      dependencies: [
        { predecessor: 'a', successor: 'c' },
        { predecessor: 'b', successor: 'c' }
      ]
    }
  });
  const firstRoundTitles = [];
  const pool = await createWorkflowWorkerPool({
    engine,
    workflowId: created.workflow.workflowId,
    workerCount: 3,
    runnerIdPrefix: 'dependency',
    context: contextOptions,
    adapter: async ({ task }) => {
      firstRoundTitles.push(task.title);
      await delay(30);
      return { status: 'done', doneSummary: `完成 ${task.title}` };
    }
  });

  const firstRound = await pool.runOnce();
  const firstRoundDoneTitles = firstRound.results.filter((result) => result.status === 'done').map((result) => result.task.title);
  assert(firstRoundDoneTitles.includes('前置任务 A'), 'first round should execute predecessor A');
  assert(firstRoundDoneTitles.includes('前置任务 B'), 'first round should execute predecessor B');
  assert(!firstRoundDoneTitles.includes('后继任务 C'), 'first round should not execute successor C before predecessors finish');

  const drained = await pool.drain({ maxRounds: 3 });
  const finalState = engine.getWorkflowState({ workflowId: created.workflow.workflowId });
  assert(drained.status === 'done', 'dependency workflow should finish after successor becomes ready');
  assert(finalState.tasks.every((task) => task.status === 'done'), 'dependency workflow tasks should all be done');
  assert(firstRoundTitles.includes('后继任务 C'), 'successor should execute in a later round');
}

async function testBlockedRound(engine, contextOptions) {
  const created = engine.createWorkflowFromInstruction({
    instruction: 'worker pool 处理混合 block 结果',
    concurrencyLimit: 2,
    plan: {
      goal: 'worker pool 处理混合 block 结果',
      steps: [
        { key: 'done', title: '可完成任务', type: 'implement' },
        { key: 'blocked', title: '需阻塞任务', type: 'implement' }
      ],
      dependencies: []
    }
  });
  const pool = await createWorkflowWorkerPool({
    engine,
    workflowId: created.workflow.workflowId,
    workerCount: 2,
    runnerIdPrefix: 'blocked',
    context: contextOptions,
    adapter: async ({ task }) => {
      await delay(20);
      if (task.title.includes('阻塞')) {
        return { status: 'blocked', blockedReason: `等待人工处理：${task.title}` };
      }
      return { status: 'done', doneSummary: `完成 ${task.title}` };
    }
  });

  const result = await pool.drain({ maxRounds: 2 });
  const finalState = engine.getWorkflowState({ workflowId: created.workflow.workflowId });

  assert(result.status === 'blocked', 'pool should stop as blocked when a worker blocks');
  assert(result.steps.some((step) => step.status === 'done'), 'blocked round should preserve completed task outcome');
  assert(result.steps.some((step) => step.status === 'blocked'), 'blocked round should preserve blocked task outcome');
  assert(finalState.tasks.some((task) => task.status === 'done'), 'one task should remain done');
  assert(finalState.tasks.some((task) => task.status === 'blocked'), 'one task should remain blocked');
}

async function testWrapperWorkerCount(engine, contextOptions) {
  const wrapper = await createAgentWorkflowWrapper({
    engine,
    context: contextOptions,
    adapter: async ({ task, runnerId }) => {
      await delay(30);
      return { status: 'done', doneSummary: `包装器 worker ${runnerId} 完成 ${task.title}` };
    }
  });

  const result = await wrapper.runInstruction({
    instruction: 'wrapper workerCount 并行执行',
    concurrencyLimit: 2,
    workerCount: 2,
    runnerIdPrefix: 'wrapper-pool',
    maxSteps: 4,
    plan: {
      goal: 'wrapper workerCount 并行执行',
      steps: [
        { key: 'a', title: '包装器并行 A', type: 'implement' },
        { key: 'b', title: '包装器并行 B', type: 'implement' }
      ],
      dependencies: []
    }
  });

  assert(result.status === 'done', 'wrapper workerCount path should finish workflow');
  assert(result.workerCount === 2, 'wrapper result should expose workerCount');
  assert(Array.isArray(result.rounds) && result.rounds.length >= 1, 'wrapper result should expose pool rounds');
  assert(new Set(result.steps.filter((step) => step.status === 'done').map((step) => step.runnerId)).size === 2, 'wrapper pool should use distinct runner ids');
}

function hasOverlap(executions) {
  for (let i = 0; i < executions.length; i++) {
    for (let j = i + 1; j < executions.length; j++) {
      if (executions[i].startedAt < executions[j].endedAt && executions[j].startedAt < executions[i].endedAt) {
        return true;
      }
    }
  }

  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
