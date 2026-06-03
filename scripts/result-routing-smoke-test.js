import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createWorkflowEngine,
  createWorkflowRunner
} from '../index.js';
import { closeDb } from '../storage/db.js';

const PROTOCOL_VERSION = 'workflow-closure-cli/v1';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const cliPath = path.join(rootDir, 'cli.js');
const dbPath = path.join(__dirname, 'result-routing-smoke-test.db');
const artifactRelativePath = 'scripts/.tmp/result-routing/decision.txt';
const artifactPath = path.join(rootDir, 'scripts', '.tmp', 'result-routing', 'decision.txt');

async function main() {
  await fs.rm(dbPath, { force: true });
  await fs.rm(artifactPath, { force: true });

  const engine = await createWorkflowEngine({ dbPath });
  const workflowId = 'result-routing-smoke';
  const created = engine.createWorkflowFromInstruction({
    workflowId,
    instruction: '验证结果驱动的 workflow 分支',
    plan: {
      goal: '验证结果驱动的 workflow 分支',
      steps: [
        { key: 'producer', title: '生成路由结果', description: '输出 routing signal。' },
        { key: 'unconditional', title: '无条件后继', description: '普通依赖完成后应变为 ready。' },
        { key: 'reviewer', title: 'Reviewer 分支', description: 'routing signal 指向 reviewer 时执行。' },
        { key: 'publisher', title: 'Publisher 分支', description: 'routing signal 指向 publisher 时执行。' }
      ],
      dependencies: [
        { predecessor: 'producer', successor: 'unconditional' },
        {
          predecessor: 'producer',
          successor: 'reviewer',
          condition: {
            outputKind: 'result',
            outputName: 'runner-result',
            path: 'metadata.routingSignal.next',
            operator: 'equals',
            value: 'reviewer'
          }
        },
        {
          predecessor: 'producer',
          successor: 'publisher',
          condition: {
            outputKind: 'result',
            outputName: 'runner-result',
            path: 'metadata.routingSignal.next',
            operator: 'equals',
            value: 'publisher'
          }
        }
      ]
    }
  });

  const producer = created.tasks.find((task) => task.planTaskKey === 'producer');
  const unconditional = created.tasks.find((task) => task.planTaskKey === 'unconditional');
  const reviewer = created.tasks.find((task) => task.planTaskKey === 'reviewer');
  const publisher = created.tasks.find((task) => task.planTaskKey === 'publisher');

  const manualOutput = engine.addTaskOutput({
    workflowId,
    taskId: producer.taskId,
    kind: 'note',
    name: 'manual-note',
    content: 'manual task output still works',
    metadata: { source: 'smoke-test' }
  });
  const manualOutputs = engine.listTaskOutputs({
    workflowId,
    taskId: producer.taskId,
    kind: 'note'
  });
  assert(manualOutputs.some((output) => output.outputId === manualOutput.outputId), 'manual task output APIs should round-trip through public exports');

  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workspacePath: rootDir,
    runnerId: 'result-routing-runner',
    taskId: producer.taskId,
    adapter: async () => ({
      status: 'done',
      doneSummary: 'producer selected reviewer',
      payload: {
        routingSignal: { next: 'reviewer' },
        outputs: [
          {
            kind: 'artifact',
            name: 'decision-record',
            contentText: 'reviewer branch selected',
            path: artifactRelativePath,
            metadata: { branch: 'reviewer' }
          }
        ]
      },
      handoff: {
        summary: 'route to reviewer',
        artifacts: ['artifacts/decision.txt'],
        decisions: ['reviewer branch selected'],
        openQuestions: [],
        risks: [],
        recommendedNextRole: 'reviewer'
      }
    })
  });

  const runResult = await runner.runOnce();
  assert(runResult.status === 'done', 'producer runner should complete successfully');

  const outputs = engine.listTaskOutputs({ workflowId, taskId: producer.taskId, limit: 20 });
  const defaultOutput = outputs.find((output) => output.kind === 'result' && output.name === 'runner-result');
  const summaryOutput = outputs.find((output) => output.kind === 'summary' && output.name === 'task-summary');
  const handoffOutput = outputs.find((output) => output.kind === 'handoff' && output.name === 'task-handoff');
  const decisionOutput = outputs.find((output) => output.kind === 'decision' && output.name === 'task-decision');
  const explicitOutput = outputs.find((output) => output.kind === 'artifact' && output.name === 'decision-record');
  assert(defaultOutput, 'runner done result should capture the default runner-result output');
  assert(defaultOutput.content === 'producer selected reviewer', 'default runner output should capture doneSummary as content');
  assert(defaultOutput.metadata?.routingSignal?.next === 'reviewer', 'default runner output should capture routingSignal metadata');
  assert(defaultOutput.metadata?.handoffSummary === 'route to reviewer', 'default runner output should capture handoff summary');
  assert(defaultOutput.path === `artifacts/workflows/${workflowId}/${producer.taskId}/results/runner-result-${defaultOutput.outputId}.txt`, 'default runner-result output should receive a generated storage path');
  assert(defaultOutput.metadata?.artifactRef === `file:artifacts/workflows/${workflowId}/${producer.taskId}/results/runner-result-${defaultOutput.outputId}.txt`, 'default runner-result output should expose generated artifactRef metadata');
  assert(defaultOutput.metadata?.storageStatus === 'written', 'default runner-result output should be materialized by default when workspacePath is available');
  assert(defaultOutput.metadata?.relativePath === `artifacts/workflows/${workflowId}/${producer.taskId}/results/runner-result-${defaultOutput.outputId}.txt`, 'default runner-result output should expose normalized generated relative path metadata');
  assert(defaultOutput.metadata?.workspacePath?.replaceAll('\\', '/').toLowerCase() === rootDir.replaceAll('\\', '/').toLowerCase(), 'default runner-result output should preserve workspacePath metadata after generated routing');
  assert(summaryOutput, 'runner done result should capture a normalized summary output');
  assert(summaryOutput.content === 'producer selected reviewer', 'summary output should capture doneSummary as content');
  assert(summaryOutput.path === `artifacts/workflows/${workflowId}/${producer.taskId}/results/task-summary-${summaryOutput.outputId}.txt`, 'summary output should route into the results directory');
  assert(handoffOutput, 'runner done result should capture a normalized handoff output');
  assert(handoffOutput.path === `artifacts/workflows/${workflowId}/${producer.taskId}/handoffs/task-handoff-${handoffOutput.outputId}.txt`, 'handoff output should route into the handoffs directory');
  assert(handoffOutput.content.includes('route to reviewer'), 'handoff output should preserve structured handoff content');
  assert(decisionOutput, 'runner done result should capture normalized decision outputs');
  assert(decisionOutput.content === 'reviewer branch selected', 'decision output should preserve handoff decisions');
  assert(decisionOutput.path === `artifacts/workflows/${workflowId}/${producer.taskId}/decisions/task-decision-${decisionOutput.outputId}.txt`, 'decision output should route into the decisions directory');
  const defaultArtifactContent = await fs.readFile(path.join(rootDir, defaultOutput.path), 'utf8');
  assert(defaultArtifactContent === 'producer selected reviewer', 'default runner-result output should materialize content into the workspace');
  assert(explicitOutput, 'runner should capture explicit adapter payload outputs');
  assert(explicitOutput.content === 'reviewer branch selected', 'explicit payload output content should be preserved');
  assert(explicitOutput.path === artifactRelativePath, 'explicit payload output path should be preserved');

  const artifactContent = await fs.readFile(artifactPath, 'utf8');
  assert(artifactContent === 'reviewer branch selected', 'explicit artifact outputs should materialize content into the workspace');
  assert(explicitOutput.metadata?.artifactRef === `file:${artifactRelativePath.replaceAll('\\', '/')}`, 'explicit payload output should expose artifactRef metadata');
  assert(explicitOutput.metadata?.storageStatus === 'written', 'explicit payload output should expose storage status metadata');
  assert(explicitOutput.metadata?.relativePath === artifactRelativePath.replaceAll('\\', '/'), 'explicit payload output should expose normalized relative path metadata');
  assert(explicitOutput.metadata?.workspacePath?.replaceAll('\\', '/').toLowerCase() === rootDir.replaceAll('\\', '/').toLowerCase(), 'explicit payload output should preserve workspacePath metadata');

  const routedState = engine.getWorkflowState({ workflowId });
  const routedUnconditional = routedState.tasks.find((task) => task.taskId === unconditional.taskId);
  const routedReviewer = routedState.tasks.find((task) => task.taskId === reviewer.taskId);
  const routedPublisher = routedState.tasks.find((task) => task.taskId === publisher.taskId);
  assert(routedUnconditional.status === 'ready', 'unconditional successor should become ready after predecessor completion');
  assert(routedReviewer.status === 'ready', 'true conditional successor should become ready');
  assert(routedPublisher.status === 'skipped', 'false conditional successor should become skipped');
  assert(routedPublisher.reasonCode === 'dependency_condition_not_met', 'false conditional successor should record the dependency skip reason');
  assert(routedState.runLogs.some((log) => log.action === 'task_skipped_by_dependency_condition' && log.taskId === publisher.taskId), 'workflow run logs should record the skipped conditional branch');

  const predecessorOutputs = engine.listPredecessorTaskOutputs({
    workflowId,
    taskId: reviewer.taskId,
    kind: 'result',
    limitPerTask: 5
  });
  assert(predecessorOutputs.some((item) => item.output.outputId === defaultOutput.outputId), 'downstream tasks should retrieve captured predecessor outputs');

  const firstReadyClaim = engine.claimNextReadyTask({ workflowId, leaseOwner: 'result-routing-smoke', leaseMs: 60_000 });
  assert([reviewer.taskId, unconditional.taskId].includes(firstReadyClaim?.task?.taskId), 'a ready executable branch should be claimable after routing');
  engine.advanceTaskStatus({
    workflowId,
    taskId: firstReadyClaim.task.taskId,
    status: 'done',
    doneSummary: `${firstReadyClaim.task.title} completed`,
    expectedLeaseOwner: 'result-routing-smoke'
  });

  const secondReadyClaim = engine.claimNextReadyTask({ workflowId, leaseOwner: 'result-routing-smoke', leaseMs: 60_000 });
  const expectedRemainingTaskId = firstReadyClaim.task.taskId === reviewer.taskId ? unconditional.taskId : reviewer.taskId;
  assert(secondReadyClaim?.task?.taskId === expectedRemainingTaskId, 'the remaining ready branch should be claimable after the first branch completes');
  engine.advanceTaskStatus({
    workflowId,
    taskId: secondReadyClaim.task.taskId,
    status: 'done',
    doneSummary: `${secondReadyClaim.task.title} completed`,
    expectedLeaseOwner: 'result-routing-smoke'
  });

  const completedState = engine.getWorkflowState({ workflowId });
  assert(completedState.workflow.status === 'done', 'workflow should become done once executable branches finish and the false branch is skipped');

  const failureWorkflowId = 'result-routing-error-smoke';
  const failureCreated = engine.createWorkflowFromInstruction({
    workflowId: failureWorkflowId,
    instruction: '验证错误结果路由',
    plan: {
      goal: '验证错误结果路由',
      steps: [
        { key: 'failure', title: '失败任务', description: 'adapter 抛错后应记录 error output。' }
      ],
      dependencies: []
    }
  });
  const failureTask = failureCreated.tasks[0];
  const failureRunner = await createWorkflowRunner({
    dbPath,
    engine,
    workspacePath: rootDir,
    runnerId: 'result-routing-error-runner',
    taskId: failureTask.taskId,
    maxTaskRetries: 0,
    adapter: async () => {
      throw new Error('adapter exploded for routing');
    }
  });
  const failureRunResult = await failureRunner.runOnce();
  assert(failureRunResult.status === 'blocked', 'runner errors should block the task when retries are exhausted');
  const failureOutputs = engine.listTaskOutputs({ workflowId: failureWorkflowId, taskId: failureTask.taskId, limit: 10 });
  const errorOutput = failureOutputs.find((output) => output.kind === 'error' && output.name === 'task-error');
  const failureHandoffOutput = failureOutputs.find((output) => output.kind === 'handoff' && output.name === 'task-handoff');
  assert(errorOutput, 'runner error path should persist a normalized error output');
  assert(errorOutput.content.includes('adapter exploded for routing'), 'error output should preserve the failure message');
  assert(errorOutput.path === `artifacts/workflows/${failureWorkflowId}/${failureTask.taskId}/errors/task-error-${errorOutput.outputId}.txt`, 'error output should route into the errors directory');
  assert(failureHandoffOutput, 'runner error path should persist a handoff output for recovery context');
  const summaryResponse = await runCli('get-workflow-state', {
    dbPath,
    workflowId
  });
  assertProtocol(summaryResponse, 'get-workflow-state', 'ok');
  assert(summaryResponse.summary?.countsByStatus?.skipped === 1, 'CLI workflow summary should count skipped tasks');
  assert(summaryResponse.summary?.progress?.skipped === 1, 'CLI workflow summary progress should include skipped tasks');

  const inspectionResponse = await runCli('inspect-workflow', {
    dbPath,
    workflowId
  });
  assertProtocol(inspectionResponse, 'inspect-workflow', 'ok');
  assert(inspectionResponse.inspection?.skippedTasks?.some((task) => task.taskId === publisher.taskId && task.reasonCode === 'dependency_condition_not_met'), 'CLI workflow inspection should expose skipped task details');

}

async function runCli(command, input = {}) {
  const args = [cliPath, command, '--input', JSON.stringify(input)];

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

  if (result.code !== 0) {
    throw new Error(`CLI command failed: ${command}\n${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout);
}

function assertProtocol(response, command, status) {
  assert(response && typeof response === 'object', `${command} should return a JSON object`);
  assert(response.protocolVersion === PROTOCOL_VERSION, `${command} should expose protocolVersion`);
  assert(response.command === command, `${command} should echo the command name`);
  assert(response.status === status, `${command} should report status ${status}`);
  assert(Array.isArray(response.allowedNextCommands), `${command} should expose allowedNextCommands`);
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
