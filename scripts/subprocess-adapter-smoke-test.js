import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSubprocessAdapter,
  createWorkflowEngine,
  createWorkflowRunner
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'subprocess-adapter-smoke-test.db');
const fixtureDir = path.join(__dirname, 'fixtures');

async function main() {
  await fs.rm(dbPath, { force: true });

  await testJsonDone();
  await testJsonBlocked();
  await testNestedJsonDone();
  await testInvalidNestedContractBlocked();
  await testTextDone();
  await testInvalidJsonBlocked();
  await testExitNonzeroBlocked();
  await testTimeoutBlocked();

  console.log('subprocess adapter smoke test passed');
}

async function testJsonDone() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'subprocess-json-done',
    instruction: '验证 subprocess adapter 的 json done 路径',
    title: '执行 subprocess json done',
    adapter: createSubprocessAdapter({
      command: process.execPath,
      args: [path.join(fixtureDir, 'subprocess-worker-done.js')]
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');

  assert(step.status === 'done', 'json done path should complete');
  assert(task?.status === 'done', 'json done task should persist done status');
  assert(step.adapterPayload?.workerPayload?.worker === 'done', 'json done payload should preserve worker payload');
  assert(step.adapterPayload?.workerPayload?.protocolVersion === 'workflow-closure-subprocess-adapter/v1', 'json done payload should record protocol version');
  assert(step.adapterPayload?.process?.stdout.includes('subprocess 完成'), 'json done payload should preserve raw stdout');
  assert(completionLog?.payload?.adapterPayload?.workerPayload?.taskId === step.task.taskId, 'json done run log should persist worker payload');
}

async function testJsonBlocked() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'subprocess-json-blocked',
    instruction: '验证 subprocess adapter 的 json blocked 路径',
    title: '执行 subprocess json blocked',
    adapter: createSubprocessAdapter({
      command: process.execPath,
      args: [path.join(fixtureDir, 'subprocess-worker-blocked.js')]
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'json blocked path should block');
  assert(task?.status === 'blocked', 'json blocked task should persist blocked status');
  assert(step.task.blockedReason.includes('subprocess 阻塞'), 'json blocked task should preserve worker blockedReason');
  assert(step.adapterPayload?.workerPayload?.worker === 'blocked', 'json blocked payload should preserve worker payload');
  assert(blockedLog?.payload?.adapterPayload?.workerPayload?.taskId === step.task.taskId, 'json blocked run log should persist worker payload');
}

async function testNestedJsonDone() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'subprocess-nested-json-done',
    instruction: '验证 subprocess adapter 的 nested json done 路径',
    title: '执行 subprocess nested json done',
    adapter: createSubprocessAdapter({
      command: process.execPath,
      args: [path.join(fixtureDir, 'subprocess-worker-nested-done.js')]
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const outputs = engine.listTaskOutputs({ workflowId: workflow.workflow.workflowId, taskId: step.task.taskId });
  const runnerResult = outputs.find((output) => output.name === 'runner-result');
  const nestedTopLevelOutput = outputs.find((output) => output.name === 'nested-top-level-output');
  const nestedPayloadOutput = outputs.find((output) => output.name === 'implementation-note');

  assert(step.status === 'done', 'nested json done path should complete');
  assert(task?.status === 'done', 'nested json done task should persist done status');
  assert(step.handoff?.summary === 'nested handoff summary', 'nested json done should preserve structured handoff summary');
  assert(step.handoff?.recommendedNextRole === 'reviewer', 'nested json done should preserve recommended next role');
  assert(step.handoff?.sourceRef === 'fixture://subprocess-worker-nested-done', 'nested json done should preserve handoff sourceRef');
  assert(step.adapterPayload?.workerPayload?.outputs?.length === 1, 'nested json done should preserve nested payload outputs in worker payload');
  assert(runnerResult?.metadata?.handoffSummary === 'nested handoff summary', 'runner result should capture handoff summary metadata');
  assert(nestedTopLevelOutput?.content === 'top-level output content', 'nested json done should persist top-level task output content');
  assert(nestedPayloadOutput?.path === 'artifacts/nested-output.txt', 'nested json done should persist payload output path');
  assert(nestedPayloadOutput?.metadata?.source === 'fixture', 'nested json done should persist payload output metadata');
}

async function testInvalidNestedContractBlocked() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'subprocess-invalid-nested-contract',
    instruction: '验证 subprocess adapter 的 invalid nested contract 路径',
    title: '执行 subprocess invalid nested contract',
    adapter: createSubprocessAdapter({
      command: process.execPath,
      args: [path.join(fixtureDir, 'subprocess-worker-invalid-nested.js')]
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'invalid nested contract path should block');
  assert(step.task.blockedReason.includes('invalid adapter result'), 'invalid nested contract path should explain contract failure');
  assert(step.adapterPayload?.parseError.includes('handoff.artifacts[0] must be a non-empty string'), 'invalid nested contract path should expose nested validation error');
  assert(blockedLog?.payload?.adapterPayload?.parseError === step.adapterPayload.parseError, 'invalid nested contract run log should persist nested validation error');
}

async function testTextDone() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'subprocess-text-done',
    instruction: '验证 subprocess adapter 的 text 路径',
    title: '执行 subprocess text done',
    adapter: createSubprocessAdapter({
      command: process.execPath,
      args: [path.join(fixtureDir, 'subprocess-worker-text.js')],
      stdoutMode: 'text'
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');

  assert(step.status === 'done', 'text path should complete');
  assert(step.task.doneSummary === 'subprocess 文本完成摘要', 'text path should map stdout to doneSummary');
  assert(step.adapterPayload?.stdoutMode === 'text', 'text path should preserve stdoutMode');
  assert(step.adapterPayload?.stdout === 'subprocess 文本完成摘要', 'text path should preserve raw stdout');
  assert(completionLog?.payload?.adapterPayload?.stdout === 'subprocess 文本完成摘要', 'text path run log should persist stdout');
}

async function testInvalidJsonBlocked() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'subprocess-invalid-json',
    instruction: '验证 subprocess adapter 的 invalid json 路径',
    title: '执行 subprocess invalid json',
    adapter: createSubprocessAdapter({
      command: process.execPath,
      args: [path.join(fixtureDir, 'subprocess-worker-invalid-json.js')]
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'invalid json path should block');
  assert(step.task.blockedReason.includes('invalid JSON'), 'invalid json path should explain parse failure');
  assert(typeof step.adapterPayload?.parseError === 'string' && step.adapterPayload.parseError.length > 0, 'invalid json path should expose parseError');
  assert(blockedLog?.payload?.adapterPayload?.parseError === step.adapterPayload.parseError, 'invalid json run log should persist parseError');
}

async function testExitNonzeroBlocked() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'subprocess-exit-nonzero',
    instruction: '验证 subprocess adapter 的 non-zero exit 路径',
    title: '执行 subprocess nonzero exit',
    adapter: createSubprocessAdapter({
      command: process.execPath,
      args: [path.join(fixtureDir, 'subprocess-worker-exit-nonzero.js')]
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'non-zero exit path should block');
  assert(step.task.blockedReason.includes('code 7'), 'non-zero exit path should mention exit code');
  assert(step.adapterPayload?.exitCode === 7, 'non-zero exit path should expose exit code');
  assert(step.adapterPayload?.stderr.includes('failed intentionally'), 'non-zero exit path should expose stderr');
  assert(blockedLog?.payload?.adapterPayload?.exitCode === 7, 'non-zero exit run log should persist exit code');
}

async function testTimeoutBlocked() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'subprocess-timeout',
    instruction: '验证 subprocess adapter 的 timeout 路径',
    title: '执行 subprocess timeout',
    adapter: createSubprocessAdapter({
      command: process.execPath,
      args: [path.join(fixtureDir, 'subprocess-worker-timeout.js')],
      timeoutMs: 100
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'timeout path should block');
  assert(step.task.blockedReason.includes('timed out'), 'timeout path should mention timeout');
  assert(step.adapterPayload?.timedOut === true, 'timeout path should expose timedOut flag');
  assert(blockedLog?.payload?.adapterPayload?.timedOut === true, 'timeout run log should persist timedOut flag');
}

async function createSingleTaskRunner({ runnerId, instruction, title, adapter }) {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = engine.createWorkflowFromInstruction({
    instruction,
    plan: {
      goal: instruction,
      steps: [
        {
          key: 'step-1',
          title,
          description: title
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
    adapter
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
