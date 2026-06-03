import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClaudeCodeAdapter,
  createWorkflowEngine,
  createWorkflowRunner
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'claude-code-adapter-smoke-test.db');
const fixturePath = path.join(__dirname, 'fixtures', 'claude-code-smoke-worker.js');
const transientStatePath = path.join(__dirname, 'claude-code-adapter-transient-state.txt');
const transientApi502StatePath = path.join(__dirname, 'claude-code-adapter-transient-api-502-state.txt');
const missingCwdPath = path.join(__dirname, 'missing-claude-code-adapter-cwd');

async function main() {
  await fs.rm(dbPath, { force: true });
  await fs.rm(transientStatePath, { force: true });
  await fs.rm(transientApi502StatePath, { force: true });
  await fs.rm(missingCwdPath, { recursive: true, force: true });

  await testClaudeCodeDone();
  await testClaudeCodeBlocked();
  await testClaudeCodePreflightBlocked();
  await testClaudeCodeSimpleCoordinatorBypass();
  await testClaudeCodeTransientRetry();
  await testClaudeCodeTransientApi502Retry();

  console.log('claude-code adapter smoke test passed');
}

async function testClaudeCodeDone() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'claude-code-done',
    instruction: '验证 Claude Code adapter done 路径',
    title: '执行 Claude Code done smoke',
    adapter: createClaudeCodeAdapter({
      command: process.execPath,
      args: [fixturePath],
      systemInstruction: 'Fake Claude Code smoke adapter should inspect the generated prompt.'
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');

  assert(step.status === 'done', 'claude-code done path should complete');
  assert(task?.status === 'done', 'claude-code done task should persist done status');
  assert(step.task.doneSummary.includes('claude-code smoke done'), 'claude-code done path should preserve doneSummary');
  assert(step.adapterPayload?.workerPayload?.worker === 'claude-code-smoke', 'claude-code done payload should preserve worker payload');
  assert(step.adapterPayload?.workerPayload?.promptHasTask === true, 'claude-code prompt should include task context');
  assert(step.adapterPayload?.workerPayload?.promptRequiresJson === true, 'claude-code prompt should require strict JSON output');
  assert(step.adapterPayload?.workerPayload?.promptRequiresHandoff === true, 'claude-code prompt should describe handoff output');
  assert(step.adapterPayload?.workerPayload?.promptRequiresOutputs === true, 'claude-code prompt should describe structured output routing for files');
  assert(completionLog?.payload?.adapterPayload?.workerPayload?.taskId === step.task.taskId, 'claude-code done run log should persist worker payload');
}

async function testClaudeCodeBlocked() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'claude-code-blocked',
    instruction: '验证 Claude Code adapter blocked 路径',
    title: '执行 Claude Code blocked smoke',
    adapter: createClaudeCodeAdapter({
      command: process.execPath,
      args: [fixturePath, '--blocked'],
      systemInstruction: 'Fake Claude Code smoke adapter should inspect the generated prompt.'
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'claude-code blocked path should block');
  assert(task?.status === 'blocked', 'claude-code blocked task should persist blocked status');
  assert(step.task.blockedReason.includes('claude-code smoke blocked'), 'claude-code blocked path should preserve blockedReason');
  assert(step.adapterPayload?.workerPayload?.promptHasTask === true, 'claude-code blocked prompt should include task context');
  assert(step.adapterPayload?.workerPayload?.promptRequiresJson === true, 'claude-code blocked prompt should require JSON output');
  assert(step.adapterPayload?.workerPayload?.promptRequiresOutputs === true, 'claude-code blocked prompt should describe structured output routing for files');
  assert(blockedLog?.payload?.adapterPayload?.workerPayload?.taskId === step.task.taskId, 'claude-code blocked run log should persist worker payload');
}


async function testClaudeCodePreflightBlocked() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'claude-code-preflight-blocked',
    instruction: '验证 Claude Code adapter preflight blocked 路径',
    title: '执行 Claude Code preflight blocked smoke',
    adapter: createClaudeCodeAdapter({
      command: process.execPath,
      args: [fixturePath],
      cwd: missingCwdPath,
      env: {
        WORKFLOW_CLOSURE_CLAUDE_WORKSPACE_PATH: missingCwdPath,
        WORKFLOW_CLOSURE_CLAUDE_DB_PATH: dbPath
      },
      systemInstruction: 'Fake Claude Code smoke adapter should not be invoked when preflight blocks.'
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'claude-code preflight should block missing cwd');
  assert(task?.status === 'blocked', 'claude-code preflight blocked task should persist blocked status');
  assert(step.task.blockedReason.includes('cwd is not available'), 'claude-code preflight should explain missing cwd');
  assert(step.adapterPayload?.adapter === 'claude-code', 'claude-code preflight payload should identify adapter');
  assert(step.adapterPayload?.phase === 'preflight', 'claude-code preflight payload should identify phase');
  assert(step.adapterPayload?.error === 'cwd-unavailable', 'claude-code preflight payload should classify missing cwd');
  assert(step.adapterPayload?.workerPayload == null, 'claude-code preflight should not invoke fake worker');
  assert(blockedLog?.payload?.adapterPayload?.phase === 'preflight', 'claude-code preflight blocked log should persist payload');
}

async function testClaudeCodeSimpleCoordinatorBypass() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'coordinator',
    instruction: '验证 Claude Code adapter simple coordinator bypass 路径',
    title: '确认 workflow runtime scope',
    type: 'runtime_confirmation',
    preferredRole: 'coordinator',
    agentIdentity: {
      agentId: 'coordinator-smoke',
      role: 'coordinator'
    },
    adapter: createClaudeCodeAdapter({
      command: process.execPath,
      args: [fixturePath],
      simpleCoordinatorBypass: true,
      systemInstruction: 'Fake Claude Code smoke adapter should not be invoked when coordinator bypass applies.'
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');

  assert(step.status === 'done', 'simple coordinator bypass should complete');
  assert(task?.status === 'done', 'simple coordinator bypass task should persist done status');
  assert(step.adapterPayload?.adapter === 'claude-code', 'simple coordinator bypass payload should identify adapter');
  assert(step.adapterPayload?.bypass === 'simple-coordinator', 'simple coordinator bypass payload should identify bypass');
  assert(step.adapterPayload?.workerPayload == null, 'simple coordinator bypass should not invoke fake worker');
  assert(completionLog?.payload?.adapterPayload?.bypass === 'simple-coordinator', 'simple coordinator bypass completion log should persist payload');
}

async function testClaudeCodeTransientRetry() {
  await fs.rm(transientStatePath, { force: true });

  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'claude-code-transient-retry',
    instruction: '验证 Claude Code adapter transient subprocess 退出会自动重试',
    title: '执行 Claude Code transient retry smoke',
    maxTaskRetries: 2,
    adapter: createClaudeCodeAdapter({
      command: process.execPath,
      args: [fixturePath, '--transient-state-path', transientStatePath],
      systemInstruction: 'Fake Claude Code smoke adapter should inspect the generated prompt.'
    })
  });

  const firstStep = await runner.runOnce();
  const stateAfterFirstFailure = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const taskAfterFirstFailure = stateAfterFirstFailure.tasks[0];
  const retryLog = findTaskRunLog(stateAfterFirstFailure.runLogs, taskAfterFirstFailure.taskId, 'task_retry_scheduled_by_runner');

  assert(firstStep.status === 'ready', 'transient Claude subprocess exit should schedule retry');
  assert(taskAfterFirstFailure.status === 'ready', 'transient Claude subprocess exit should move the task back to ready');
  assert(taskAfterFirstFailure.reasonCode === 'runner_execution_retry', 'transient Claude subprocess exit should persist retry reason code');
  assert(taskAfterFirstFailure.lastError.includes('Claude subprocess exited transiently'), 'transient Claude subprocess exit should persist classified transient error');
  assert(retryLog?.payload?.recovery?.reasonCode === 'runner_execution_retry', 'transient Claude subprocess exit should write retry scheduling log');

  const secondStep = await runner.runOnce();
  const finalState = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const finalTask = finalState.tasks[0];
  const completionLog = findTaskRunLog(finalState.runLogs, finalTask.taskId, 'task_completed_by_runner');

  assert(secondStep.status === 'done', 'retry after transient Claude subprocess exit should complete');
  assert(secondStep.prompt.includes(`最近错误: ${taskAfterFirstFailure.lastError}`), 'retry after transient Claude subprocess exit should surface previous error in prompt');
  assert(secondStep.adapterPayload?.workerPayload?.mode === 'done-after-transient', 'retry after transient Claude subprocess exit should reach the recovered worker mode');
  assert(finalState.workflow.status === 'done', 'transient Claude subprocess retry workflow should finish');
  assert(finalTask.status === 'done', 'transient Claude subprocess retry task should finish');
  assert(finalTask.attemptCount === 2, 'transient Claude subprocess retry task should increment attempt count on recovery');
  assert(completionLog?.payload?.adapterPayload?.workerPayload?.mode === 'done-after-transient', 'transient Claude subprocess retry completion log should preserve recovered worker mode');
}

async function testClaudeCodeTransientApi502Retry() {
  await fs.rm(transientApi502StatePath, { force: true });

  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'claude-code-transient-api-502-retry',
    instruction: '验证 Claude Code adapter 将 API 502 upstream 错误识别为自动重试',
    title: '执行 Claude Code transient API 502 retry smoke',
    maxTaskRetries: 2,
    adapter: createClaudeCodeAdapter({
      command: process.execPath,
      args: [fixturePath, '--transient-api-502-state-path', transientApi502StatePath],
      systemInstruction: 'Fake Claude Code smoke adapter should inspect the generated prompt.'
    })
  });

  const firstStep = await runner.runOnce();
  const stateAfterFirstFailure = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const taskAfterFirstFailure = stateAfterFirstFailure.tasks[0];
  const retryLog = findTaskRunLog(stateAfterFirstFailure.runLogs, taskAfterFirstFailure.taskId, 'task_retry_scheduled_by_runner');

  assert(firstStep.status === 'ready', 'transient Claude API 502 exit should schedule retry');
  assert(taskAfterFirstFailure.status === 'ready', 'transient Claude API 502 exit should move the task back to ready');
  assert(taskAfterFirstFailure.reasonCode === 'runner_execution_retry', 'transient Claude API 502 exit should persist retry reason code');
  assert(taskAfterFirstFailure.lastError.includes('Claude upstream 502/upstream_error'), 'transient Claude API 502 exit should persist sanitized upstream summary');
  assert(!taskAfterFirstFailure.lastError.includes('API Error: 502'), 'transient Claude API 502 exit should not persist raw API error text');
  assert(!taskAfterFirstFailure.lastError.includes('Upstream request failed'), 'transient Claude API 502 exit should not persist raw upstream JSON text');
  assert(retryLog?.payload?.recovery?.reasonCode === 'runner_execution_retry', 'transient Claude API 502 exit should write retry scheduling log');
  assert(retryLog?.payload?.adapterPayload?.quarantined === true, 'transient Claude API 502 run log should quarantine raw adapter payload');
  const retryLogText = JSON.stringify(retryLog?.payload || {});
  assert(!retryLogText.includes('Upstream request failed'), 'transient Claude API 502 run log should not persist raw upstream JSON');
  assert(!retryLogText.includes('API Error: 502'), 'transient Claude API 502 run log should not persist raw API error text');
  const firstFailureOutputs = engine.listTaskOutputs({
    workflowId: workflow.workflow.workflowId,
    taskId: taskAfterFirstFailure.taskId
  });
  const firstFailureOutputText = JSON.stringify(firstFailureOutputs);
  assert(firstFailureOutputText.includes('Claude upstream 502/upstream_error'), 'transient Claude API 502 task outputs should keep sanitized upstream summary');
  assert(!firstFailureOutputText.includes('Upstream request failed'), 'transient Claude API 502 task outputs should not persist raw upstream JSON');
  assert(!firstFailureOutputText.includes('API Error: 502'), 'transient Claude API 502 task outputs should not persist raw API error text');

  const secondStep = await runner.runOnce();
  const finalState = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const finalTask = finalState.tasks[0];
  const completionLog = findTaskRunLog(finalState.runLogs, finalTask.taskId, 'task_completed_by_runner');

  assert(secondStep.status === 'done', 'retry after transient Claude API 502 exit should complete');
  assert(secondStep.prompt.includes('Claude upstream 502/upstream_error'), 'retry after transient Claude API 502 exit should surface sanitized previous error in prompt');
  assert(!secondStep.prompt.includes('{"error":{"message":"Upstream request failed"'), 'retry after transient Claude API 502 exit should not leak full upstream error JSON into prompt');
  assert(secondStep.adapterPayload?.workerPayload?.mode === 'done-after-transient-api-502', 'retry after transient Claude API 502 exit should reach the recovered worker mode');
  assert(finalState.workflow.status === 'done', 'transient Claude API 502 retry workflow should finish');
  assert(finalTask.status === 'done', 'transient Claude API 502 retry task should finish');
  assert(finalTask.attemptCount === 2, 'transient Claude API 502 retry task should increment attempt count on recovery');
  assert(completionLog?.payload?.adapterPayload?.workerPayload?.mode === 'done-after-transient-api-502', 'transient Claude API 502 retry completion log should preserve recovered worker mode');
  const completionLogText = JSON.stringify(completionLog?.payload || {});
  assert(!completionLogText.includes('Upstream request failed'), 'transient Claude API 502 completion log should not persist raw upstream JSON from retry prompt args');
  assert(!completionLogText.includes('API Error: 502'), 'transient Claude API 502 completion log should not persist raw API text from retry prompt args');
  assert(completionLog?.payload?.adapterPayload?.quarantined !== true, 'successful retry payload should not be quarantined just because prompt args contain sanitized upstream history');
}

async function createSingleTaskRunner({ runnerId, instruction, title, type, preferredRole, agentIdentity, adapter, maxTaskRetries }) {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = engine.createWorkflowFromInstruction({
    instruction,
    plan: {
      goal: instruction,
      steps: [
        {
          key: 'step-1',
          title,
          description: title,
          ...(type ? { type, contract: { taskType: type } } : {}),
          ...(preferredRole ? { preferredRole } : {})
        }
      ],
      dependencies: []
    }
  });

  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId,
    adapter,
    ...(agentIdentity ? { agentIdentity } : {}),
    ...(maxTaskRetries != null ? { maxTaskRetries } : {})
  });

  return { engine, workflow, runner };
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
  .finally(async () => {
    await closeDb();
  });
