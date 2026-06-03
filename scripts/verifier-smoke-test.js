import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBashCommandVerifier,
  createCompositeVerifier,
  createNodeTestVerifier,
  createTaskBoundaryVerifier,
  createVerifier,
  createWorkflowEngine,
  createWorkflowRunner
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'verifier-smoke-test.db');

async function main() {
  await fs.rm(dbPath, { force: true });

  await testVerifierPassed();
  await testVerifierFailed();
  await testAdapterBlocked();
  await testSingleVerifierCompositePassthrough();
  await testCompositeVerifierPayloadContract();
  await testTaskBoundaryVerifierMissingArtifact();
  await testTaskBoundaryVerifierPassedWithCustomVerifier();
  await testNodeTestVerifierPassed();
  await testNodeTestVerifierFailed();
  await testBashCommandVerifierPassed();
  await testBashCommandVerifierFailed();

  console.log('verifier smoke test passed');
}

async function testVerifierPassed() {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = engine.createWorkflowFromInstruction('实现 verifier passed happy path');

  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'verifier-passed-runner',
    adapter: async ({ task }) => ({
      status: 'done',
      doneSummary: `adapter 完成：${task.title}`,
      payload: {
        adapterTaskId: task.taskId
      }
    }),
    verifier: createVerifier(async ({ workflow: currentWorkflow, task, result, state }) => ({
      status: 'passed',
      payload: {
        workflowId: currentWorkflow.workflowId,
        taskId: task.taskId,
        adapterStatus: result.status,
        taskCount: state.tasks.length
      }
    }))
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');

  assert(step.status === 'done', 'verifier-passed step should remain done');
  assert(step.verification?.status === 'passed', 'verifier-passed step should expose verification result');
  assert(task?.status === 'done', 'verifier-passed task should persist as done');
  assert(task?.doneSummary?.includes('adapter 完成'), 'verifier-passed task should keep adapter doneSummary');
  assert(completionLog?.payload?.verification?.status === 'passed', 'verifier-passed run log should store verification status');
  assert(completionLog?.payload?.verification?.payload?.byName?.custom?.payload?.adapterStatus === 'done', 'verifier-passed run log should store custom verification payload');
  assert(state.runLogs.some((log) => log.action === 'task_completed_by_runner'), 'verifier-passed workflow should record runner completion log');
}

async function testVerifierFailed() {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = engine.createWorkflowFromInstruction('实现 verifier failed path');

  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'verifier-failed-runner',
    adapter: async ({ task }) => ({
      status: 'done',
      doneSummary: `adapter 误报完成：${task.title}`,
      payload: {
        adapterTaskId: task.taskId
      }
    }),
    verifier: createVerifier(async ({ task, result }) => ({
      status: 'failed',
      reason: `验证未通过：${task.title}`,
      payload: {
        adapterStatus: result.status
      }
    }))
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'verifier-failed step should become blocked');
  assert(step.verification?.status === 'failed', 'verifier-failed step should expose failed verification result');
  assert(task?.status === 'blocked', 'verifier-failed task should persist as blocked');
  assert(task?.blockedReason === `验证未通过：${task.title}`, 'verifier-failed task should use verifier reason as blockedReason');
  assert(task?.lastError === task?.blockedReason, 'verifier-failed task should copy blockedReason into lastError');
  assert(blockedLog?.payload?.verification?.status === 'failed', 'verifier-failed run log should store failed verification status');
  assert(blockedLog?.payload?.verification?.payload?.byName?.custom?.payload?.adapterStatus === 'done', 'verifier-failed run log should store custom verification payload');
  assert(state.workflow.status === 'blocked', 'verifier-failed workflow should become blocked');
  assert(state.runLogs.some((log) => log.action === 'task_blocked_by_runner'), 'verifier-failed workflow should record runner blocked log');
}

async function testAdapterBlocked() {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = engine.createWorkflowFromInstruction('实现 adapter blocked path');

  let verifierCalled = false;

  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'adapter-blocked-runner',
    adapter: async ({ task }) => ({
      status: 'blocked',
      blockedReason: `adapter 阻塞：${task.title}`,
      payload: {
        adapterTaskId: task.taskId
      }
    }),
    verifier: createVerifier(async () => {
      verifierCalled = true;
      return {
        status: 'passed'
      };
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'adapter-blocked step should stay blocked');
  assert(step.verification == null, 'adapter-blocked step should not run verification');
  assert(verifierCalled === false, 'adapter-blocked path should skip verifier invocation');
  assert(task?.status === 'blocked', 'adapter-blocked task should persist as blocked');
  assert(task?.blockedReason === `adapter 阻塞：${task.title}`, 'adapter-blocked task should keep adapter blockedReason');
  assert(blockedLog?.payload?.verification == null, 'adapter-blocked run log should not store verification result');
  assert(state.workflow.status === 'blocked', 'adapter-blocked workflow should become blocked');
}

async function testNodeTestVerifierPassed() {
  const verification = await createNodeTestVerifier({
    args: ['-e', 'process.exit(0)']
  }).run({});

  assert(verification.status === 'passed', 'node-test verifier should pass on exit code 0');
  assert(verification.payload?.verifier === 'node-test', 'node-test verifier should expose verifier kind');
  assert(verification.payload?.exitCode === 0, 'node-test verifier should expose exit code 0');
}

async function testNodeTestVerifierFailed() {
  const verification = await createNodeTestVerifier({
    args: ['-e', 'process.exit(3)'],
    failureReason: 'node verifier 未通过'
  }).run({});

  assert(verification.status === 'failed', 'node-test verifier should fail on non-zero exit code');
  assert(verification.reason === 'node verifier 未通过', 'node-test verifier should use custom failure reason');
  assert(verification.payload?.exitCode === 3, 'node-test verifier should expose failing exit code');
}

async function testBashCommandVerifierPassed() {
  const verification = await createBashCommandVerifier({
    command: 'exit 0'
  }).run({});

  assert(verification.status === 'passed', 'bash verifier should pass on exit code 0');
  assert(verification.payload?.verifier === 'bash-command', 'bash verifier should expose verifier kind');
  assert(verification.payload?.exitCode === 0, 'bash verifier should expose exit code 0');
}

async function testBashCommandVerifierFailed() {
  const verification = await createBashCommandVerifier({
    command: 'node ./scripts/fixtures/subprocess-worker-exit-nonzero.js',
    cwd: path.join(__dirname, '..'),
    failureReason: ({ task }) => `bash verifier 未通过：${task?.title || 'unknown-task'}`
  }).run({
    task: {
      title: 'bash-command verifier failed path'
    }
  });

  assert(verification.status === 'failed', 'bash verifier should fail on non-zero exit code');
  assert(verification.reason === 'bash verifier 未通过：bash-command verifier failed path', 'bash verifier should resolve dynamic failure reason');
  assert(verification.payload?.exitCode === 7, 'bash verifier should expose failing exit code');
  assert(verification.payload?.command === 'node ./scripts/fixtures/subprocess-worker-exit-nonzero.js', 'bash verifier should preserve the safe command text');
}

async function testSingleVerifierCompositePassthrough() {
  const verification = await createCompositeVerifier([
    {
      name: 'custom',
      verifier: createVerifier(async ({ task, result }) => ({
        status: 'passed',
        reason: null,
        reasonCode: null,
        message: 'single verifier message',
        payload: {
          customVerifier: true,
          taskId: task.taskId,
          adapterStatus: result.status
        }
      }))
    }
  ]).run({
    task: {
      taskId: 'task-single-verifier-passthrough',
      title: '单 verifier passthrough contract'
    },
    result: {
      status: 'done',
      doneSummary: '单 verifier 已完成'
    }
  });

  assert(verification.status === 'passed', 'single-verifier composite should preserve the child verifier status');
  assert(verification.message === 'single verifier message', 'single-verifier composite should preserve the child verifier message');
  assert(verification.payload?.customVerifier === true, 'single-verifier composite should preserve the child verifier payload shape');
  assert(verification.payload?.adapterStatus === 'done', 'single-verifier composite should preserve the child verifier payload values');
  assert(verification.payload?.taskId === 'task-single-verifier-passthrough', 'single-verifier composite should preserve the child verifier payload content');
  assert(verification.payload?.results == null, 'single-verifier composite should not wrap payload in a results array');
  assert(verification.payload?.byName == null, 'single-verifier composite should not wrap payload in a byName map');
}

async function testCompositeVerifierPayloadContract() {
  const verification = await createCompositeVerifier([
    {
      name: 'task-boundary',
      verifier: createTaskBoundaryVerifier()
    },
    {
      name: 'custom',
      verifier: createVerifier(async ({ task, result }) => ({
        status: 'failed',
        reason: `custom verifier blocked: ${task.title}`,
        reasonCode: 'custom_verifier_rejected',
        message: 'custom verifier message',
        payload: {
          customVerifier: true,
          adapterStatus: result.status,
          taskId: task.taskId
        }
      }))
    }
  ]).run({
    task: {
      taskId: 'task-composite-contract',
      title: '组合 verifier payload contract',
      contract: {
        requiredArtifacts: ['artifact://required-report']
      }
    },
    result: {
      status: 'done',
      doneSummary: '已完成并包含要求的 doneSummary',
      payload: {
        handoff: {
          artifacts: ['artifact://required-report']
        }
      }
    }
  });

  assert(verification.status === 'failed', 'composite verifier contract should fail when a child verifier fails');
  assert(verification.reason === 'custom verifier blocked: 组合 verifier payload contract', 'composite verifier contract should surface the first failed verifier reason');
  assert(verification.reasonCode === 'custom_verifier_rejected', 'composite verifier contract should surface the first failed verifier reasonCode');
  assert(verification.message === 'custom verifier message', 'composite verifier contract should surface the first failed verifier message');
  assert(Array.isArray(verification.payload?.results), 'composite verifier contract should expose a results array');
  assert(verification.payload?.results?.length === 2, 'composite verifier contract should preserve both verifier results');
  assert(verification.payload?.results?.[0]?.name === 'task-boundary', 'composite verifier contract should preserve verifier result order');
  assert(verification.payload?.results?.[0]?.status === 'passed', 'composite verifier contract should record the boundary verifier result');
  assert(verification.payload?.results?.[1]?.name === 'custom', 'composite verifier contract should preserve the custom verifier entry name');
  assert(verification.payload?.results?.[1]?.status === 'failed', 'composite verifier contract should record the custom verifier result');
  assert(verification.payload?.byName?.['task-boundary']?.status === 'passed', 'composite verifier contract should expose the boundary result by name');
  assert(verification.payload?.byName?.['task-boundary']?.payload?.reportedArtifacts?.includes('artifact://required-report'), 'composite verifier contract should preserve boundary payload details');
  assert(verification.payload?.byName?.custom?.status === 'failed', 'composite verifier contract should expose the custom result by name');
  assert(verification.payload?.byName?.custom?.reason === 'custom verifier blocked: 组合 verifier payload contract', 'composite verifier contract should preserve custom reason by name');
  assert(verification.payload?.byName?.custom?.reasonCode === 'custom_verifier_rejected', 'composite verifier contract should preserve custom reasonCode by name');
  assert(verification.payload?.byName?.custom?.message === 'custom verifier message', 'composite verifier contract should preserve custom message by name');
  assert(verification.payload?.byName?.custom?.payload?.customVerifier === true, 'composite verifier contract should preserve custom payload by name');
  assert(verification.payload?.byName?.custom?.payload?.adapterStatus === 'done', 'composite verifier contract should preserve the adapter status in custom payload');
}

async function testTaskBoundaryVerifierMissingArtifact() {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = engine.createWorkflowFromInstruction({
    instruction: '验证内建任务边界校验会拦截缺失交付物',
    plan: {
      goal: '验证内建任务边界校验会拦截缺失交付物',
      steps: [
        {
          key: 'boundary-missing-artifact',
          title: '输出必须包含交付物',
          description: 'done 结果必须显式上报 artifact',
          contract: {
            requiredArtifacts: ['artifact://required-report']
          }
        }
      ],
      dependencies: []
    }
  });

  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'boundary-missing-artifact-runner',
    adapter: async ({ task }) => ({
      status: 'done',
      doneSummary: `完成但未上报交付物：${task.title}`,
      payload: {
        adapterTaskId: task.taskId
      }
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'boundary-missing-artifact step should become blocked');
  assert(step.verification?.status === 'failed', 'boundary-missing-artifact step should expose failed verification');
  assert(step.verification?.reasonCode === 'task_boundary_missing_required_artifact', 'boundary-missing-artifact step should expose the boundary reason code');
  assert(task?.status === 'blocked', 'boundary-missing-artifact task should persist as blocked');
  assert(task?.reasonCode === 'task_boundary_missing_required_artifact', 'boundary-missing-artifact task should persist the boundary reason code');
  assert(task?.blockedReason?.includes('任务缺少必需交付物'), 'boundary-missing-artifact task should use the boundary blocked reason');
  assert(blockedLog?.payload?.verification?.reasonCode === 'task_boundary_missing_required_artifact', 'boundary-missing-artifact run log should store the boundary reason code');
}

async function testTaskBoundaryVerifierPassedWithCustomVerifier() {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = engine.createWorkflowFromInstruction({
    instruction: '验证内建边界校验与自定义 verifier 会组合执行',
    plan: {
      goal: '验证内建边界校验与自定义 verifier 会组合执行',
      steps: [
        {
          key: 'boundary-pass-composed',
          title: '输出包含所需交付物',
          description: '满足 contract 后仍应继续运行 custom verifier',
          contract: {
            requiredArtifacts: ['artifact://required-report']
          }
        }
      ],
      dependencies: []
    }
  });

  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'boundary-pass-composed-runner',
    adapter: async ({ task }) => ({
      status: 'done',
      doneSummary: `完成并上报交付物：${task.title}`,
      payload: {
        handoff: {
          summary: `handoff：${task.title}`,
          artifacts: ['artifact://required-report']
        }
      }
    }),
    verifier: createVerifier(async ({ task, result }) => ({
      status: 'passed',
      payload: {
        customVerifier: true,
        taskId: task.taskId,
        adapterStatus: result.status
      }
    }))
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');

  assert(step.status === 'done', 'boundary-pass-composed step should remain done');
  assert(step.verification?.status === 'passed', 'boundary-pass-composed step should expose passed verification');
  assert(step.verification?.payload?.byName?.['task-boundary']?.status === 'passed', 'boundary-pass-composed step should include built-in boundary verifier result');
  assert(step.verification?.payload?.byName?.custom?.status === 'passed', 'boundary-pass-composed step should include custom verifier result');
  assert(step.verification?.payload?.byName?.['task-boundary']?.payload?.reportedArtifacts?.includes('artifact://required-report'), 'boundary-pass-composed step should expose reported artifacts');
  assert(step.verification?.payload?.byName?.custom?.payload?.customVerifier === true, 'boundary-pass-composed step should preserve custom verifier payload');
  assert(task?.status === 'done', 'boundary-pass-composed task should persist as done');
  assert(task?.reasonCode == null, 'boundary-pass-composed task should not persist a reason code on success');
  assert(completionLog?.payload?.verification?.payload?.byName?.['task-boundary']?.status === 'passed', 'boundary-pass-composed run log should store the built-in verifier result');
  assert(completionLog?.payload?.verification?.payload?.byName?.custom?.payload?.customVerifier === true, 'boundary-pass-composed run log should store the custom verifier payload');
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

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });

