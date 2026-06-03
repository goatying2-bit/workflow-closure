import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { closeDb } from '../storage/db.js';
import { getClaudeRuntimeProfile } from './claude-runtime-profile.js';
import { runClaudeRuntimeCli } from './claude-runtime-cli.js';
import { markTestPlan, prepareTestDb } from './helpers/test-db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const fixturePath = path.join(__dirname, 'fixtures', 'claude-code-smoke-worker.js');
const transientStatePath = path.join(__dirname, 'claude-runtime-transient-state.txt');
const transientApi502StatePath = path.join(__dirname, 'claude-runtime-transient-api-502-state.txt');
const dbPath = await prepareTestDb('claude-runtime-smoke-test');
const ensureScriptPath = path.join(__dirname, 'ensure-claude-agent.js');
const runScriptPath = path.join(__dirname, 'run-claude-assignment.js');
const opsScriptPath = path.join(__dirname, 'start-claude-ops.js');
const port = 3011;

async function main() {
  await fs.rm(transientStatePath, { force: true });
  await fs.rm(transientApi502StatePath, { force: true });
  const alternateWorkspacePath = path.join(rootDir, 'storage', 'test-workspaces', 'claude-runtime-alt-workspace');
  await fs.mkdir(alternateWorkspacePath, { recursive: true });

  const baseEnv = createRuntimeEnv({
    WORKFLOW_CLOSURE_CLAUDE_ARGS_JSON: JSON.stringify([fixturePath])
  });
  const profile = getClaudeRuntimeProfile({ env: baseEnv });

  const ensureResult = await runJsonScript(ensureScriptPath, [], baseEnv);
  assert(ensureResult.status === 'registered' || ensureResult.status === 'updated', 'ensure-claude-agent should register or update the stable Claude agent');
  assert(ensureResult.agent?.agentId === profile.agent.agentId, 'ensure-claude-agent should persist the canonical agentId');
  assert(ensureResult.runtime?.dbPath === profile.dbPath, 'ensure-claude-agent should use the canonical dbPath');
  assert(ensureResult.runtime?.adapterModule === profile.adapterModulePath, 'ensure-claude-agent should use the canonical adapter module');

  const created = await runClaudeRuntimeCli('create-workflow', {
    workflowId: 'claude-runtime-done-workflow',
    instruction: '验证 Claude runtime wrapper done 路径',
    plan: markTestPlan({
      goal: '验证 Claude runtime wrapper done 路径',
      steps: [
        {
          key: 'runtime-done',
          title: '执行 runtime done 任务',
          description: '通过长期运行 wrapper 执行 ready assignment。'
        }
      ],
      dependencies: []
    }, 'claude-runtime-smoke-test')
  }, profile);
  assert(created.status === 'ok', 'create-workflow should succeed for done-path runtime test');

  const ops = await startBackgroundScript(opsScriptPath, baseEnv, /Claude ops panel listening at/);
  try {
    const coordinatorState = await requestJson(`http://127.0.0.1:${port}/api/coordinator-state`);
    assert(coordinatorState.status === 'ok', 'ops wrapper should expose coordinator-state API');
    assert(Array.isArray(coordinatorState.agents) && coordinatorState.agents.some((agent) => agent.agentId === profile.agent.agentId), 'ops wrapper should point at the same persisted agent store');

    const doneResult = await runJsonScript(runScriptPath, [
      '--workflow-id',
      'claude-runtime-done-workflow'
    ], baseEnv);
    assert(doneResult.command === 'run-next-assignment', 'run-claude-assignment should execute coordinator work by default');
    assert(doneResult.status === 'done', 'run-claude-assignment should complete ready work when the Claude adapter returns done');
    assert(doneResult.agent?.agentId === profile.agent.agentId, 'run-claude-assignment should execute with the canonical agent');

    const doneState = await runClaudeRuntimeCli('get-workflow-state', {
      workflowId: 'claude-runtime-done-workflow'
    }, profile);
    assert(doneState.workflow?.status === 'done', 'done-path workflow should complete through the runtime wrapper');

    const workspaceEnv = createRuntimeEnv({
      WORKFLOW_CLOSURE_CLAUDE_WORKSPACE_PATH: alternateWorkspacePath,
      WORKFLOW_CLOSURE_CLAUDE_ARGS_JSON: JSON.stringify([fixturePath])
    });
    const workspaceProfile = getClaudeRuntimeProfile({ env: workspaceEnv });
    const workspaceCreated = await runClaudeRuntimeCli('create-workflow', {
      workflowId: 'claude-runtime-workspace-cwd-workflow',
      instruction: '验证 Claude runtime adapter 使用目标 workspace cwd',
      plan: markTestPlan({
        goal: '验证 Claude runtime adapter 使用目标 workspace cwd',
        steps: [
          {
            key: 'runtime-workspace-cwd',
            title: '执行 runtime workspace cwd 任务',
            description: 'fake Claude worker 应在配置的 workspacePath 下运行。'
          }
        ],
        dependencies: []
      }, 'claude-runtime-smoke-test')
    }, workspaceProfile);
    assert(workspaceCreated.status === 'ok', 'create-workflow should succeed for workspace cwd runtime test');

    const workspaceResult = await runJsonScript(runScriptPath, [
      '--workflow-id',
      'claude-runtime-workspace-cwd-workflow'
    ], workspaceEnv);
    assert(workspaceResult.status === 'done', 'workspace cwd runtime task should complete');
    assert(path.resolve(workspaceResult.step?.adapterPayload?.cwd || '') === path.resolve(alternateWorkspacePath), `Claude adapter subprocess should run from the configured workspacePath: ${JSON.stringify(workspaceResult.step?.adapterPayload)}`);
    assert(path.resolve(workspaceResult.step?.adapterPayload?.workerPayload?.envWorkspacePath || '') === path.resolve(alternateWorkspacePath), `Claude adapter subprocess should receive propagated workspace env: ${JSON.stringify(workspaceResult.step?.adapterPayload)}`);
    assert(path.resolve(workspaceResult.step?.adapterPayload?.workerPayload?.envDbPath || '') === path.resolve(dbPath), `Claude adapter subprocess should receive propagated db env: ${JSON.stringify(workspaceResult.step?.adapterPayload)}`);

    const blockedEnv = createRuntimeEnv({
      WORKFLOW_CLOSURE_CLAUDE_ARGS_JSON: JSON.stringify([fixturePath, '--blocked'])
    });
    const blockedProfile = getClaudeRuntimeProfile({ env: blockedEnv });
    const blockedCreated = await runClaudeRuntimeCli('create-workflow', {
      workflowId: 'claude-runtime-blocked-workflow',
      instruction: '验证 Claude runtime wrapper blocked/resume 路径',
      plan: markTestPlan({
        goal: '验证 Claude runtime wrapper blocked/resume 路径',
        steps: [
          {
            key: 'runtime-blocked',
            title: '执行 runtime blocked 任务',
            description: '先 blocked，再通过 resume 继续执行。'
          }
        ],
        dependencies: []
    }, 'claude-runtime-smoke-test')
    }, blockedProfile);
    assert(blockedCreated.status === 'ok', 'create-workflow should succeed for blocked-path runtime test');

    const blockedResult = await runJsonScript(runScriptPath, [
      '--workflow-id',
      'claude-runtime-blocked-workflow'
    ], blockedEnv);
    assert(blockedResult.command === 'run-next-assignment', 'blocked-path execution should still use run-next-assignment');
    assert(blockedResult.status === 'blocked', 'run-claude-assignment should surface blocked coordinator executions');
    assert(blockedResult.assignment?.assignmentId, 'blocked coordinator result should expose assignmentId for resume');

    const retryBudgetDoneEnv = createRuntimeEnv({
      WORKFLOW_CLOSURE_CLAUDE_ARGS_JSON: JSON.stringify([fixturePath])
    });
    const retryBudgetProfile = getClaudeRuntimeProfile({ env: retryBudgetDoneEnv });
    const retryBudgetCreated = await runClaudeRuntimeCli('create-workflow', {
      workflowId: 'claude-runtime-retry-budget-workflow',
      instruction: '验证 run-claude-assignment 会透传 maxTaskRetries',
      plan: markTestPlan({
        goal: '验证 run-claude-assignment 会透传 maxTaskRetries',
        steps: [
          {
            key: 'runtime-retry-budget',
            title: '执行 runtime transient retry 任务',
            description: '第一次 transient 退出，第二次恢复完成。'
          }
        ],
        dependencies: []
    }, 'claude-runtime-smoke-test')
    }, retryBudgetProfile);
    assert(retryBudgetCreated.status === 'ok', 'create-workflow should succeed for retry-budget runtime test');

    await fs.rm(transientStatePath, { force: true });
    const retryBudgetBlockedEnv = createRuntimeEnv({
      WORKFLOW_CLOSURE_CLAUDE_ARGS_JSON: JSON.stringify([fixturePath, '--transient-state-path', transientStatePath])
    });

    const retryBudgetResult = await runJsonScript(runScriptPath, [
      '--workflow-id',
      'claude-runtime-retry-budget-workflow',
      '--max-task-retries',
      '2'
    ], retryBudgetBlockedEnv);
    assert(retryBudgetResult.command === 'run-next-assignment', 'retry-budget execution should still use run-next-assignment');
    assert(retryBudgetResult.status === 'done', 'run-claude-assignment should pass maxTaskRetries through to allow transient retry recovery');

    const retryBudgetState = await runClaudeRuntimeCli('get-workflow-state', {
      workflowId: 'claude-runtime-retry-budget-workflow'
    }, retryBudgetProfile);
    const retryBudgetTask = Array.isArray(retryBudgetState.tasks) ? retryBudgetState.tasks[0] : null;
    assert(retryBudgetState.workflow?.status === 'done', 'retry-budget workflow should finish through the runtime wrapper');
    assert(retryBudgetTask?.attemptCount === 2, 'retry-budget workflow should require a second claim after transient retry');

    const cooldownProfile = getClaudeRuntimeProfile({ env: baseEnv });
    const cooldownCreated = await runClaudeRuntimeCli('create-workflow', {
      workflowId: 'claude-runtime-transient-cooldown-workflow',
      instruction: '验证 Claude runtime wrapper 会暴露 transient cooldown 状态',
      plan: markTestPlan({
        goal: '验证 Claude runtime wrapper 会暴露 transient cooldown 状态',
        steps: [
          {
            key: 'runtime-transient-cooldown',
            title: '执行 runtime transient cooldown 任务',
            description: '持续 API 502 直到 runner 用尽即时重试，然后由 coordinator 暴露 cooldown。'
          }
        ],
        dependencies: []
      }, 'claude-runtime-smoke-test')
    }, cooldownProfile);
    assert(cooldownCreated.status === 'ok', 'create-workflow should succeed for transient cooldown runtime test');

    await fs.rm(transientApi502StatePath, { force: true });
    const cooldownEnv = createRuntimeEnv({
      WORKFLOW_CLOSURE_CLAUDE_ARGS_JSON: JSON.stringify([fixturePath, '--transient-api-502-always'])
    });

    const cooldownResult = await runJsonScript(runScriptPath, [
      '--workflow-id',
      'claude-runtime-transient-cooldown-workflow',
      '--max-task-retries',
      '0'
    ], cooldownEnv);
    assert(cooldownResult.command === 'resume-assigned-work', 'cooldown runtime loop should end on resume-assigned-work after the initial blocked run');
    assert(cooldownResult.status === 'cooldown', 'run-claude-assignment should surface cooldown after repeated transient API 502 failures');
    assert(cooldownResult.nextAction === 'wait_for_recovery', 'cooldown runtime result should recommend waiting for recovery');
    assert(cooldownResult.reason === 'transient_recovery_cooldown', 'cooldown runtime result should expose transient cooldown reason');
    assert(cooldownResult.loop?.attempt === 2, 'cooldown runtime loop should resume once after the initial blocked run');
    assert(cooldownResult.loop?.autoResumed === true, 'cooldown runtime loop should report automatic resume behavior');
    assert(cooldownResult.assignment?.assignmentId, 'cooldown runtime result should preserve assignment context');
    assert(cooldownResult.assignment?.status === 'blocked', 'cooldown runtime result should preserve blocked assignment status during cooldown');
    assert(cooldownResult.target?.taskId, 'cooldown runtime result should expose the blocked target task');
    assert(cooldownResult.task?.taskId === cooldownResult.target?.taskId, 'cooldown runtime result should expose the same task in task and target');
    assert(cooldownResult.recovery?.recoveryClass === 'transient_upstream', 'cooldown runtime result should expose transient recovery class');
    assert(cooldownResult.recovery?.recoverySource === 'claude_runtime', 'cooldown runtime result should expose runtime recovery source');
    assert(cooldownResult.recovery?.retryBudget?.attemptCount === 1, 'cooldown runtime result should expose retry budget attempt count');
    assert(cooldownResult.recovery?.retryBudget?.remainingRetries === 0, 'cooldown runtime result should expose exhausted retry budget');
    assert(Number.isInteger(cooldownResult.recovery?.cooldownMs) && cooldownResult.recovery.cooldownMs > 0, 'cooldown runtime result should expose cooldownMs');
    assert(cooldownResult.recoveryStatus?.phase === 'cooldown', 'cooldown runtime result should expose cooldown phase');
    assert(cooldownResult.recoveryStatus?.recovery?.recoveryClass === 'transient_upstream', 'cooldown runtime result should keep recovery payload inside recoveryStatus');
    assert(typeof cooldownResult.waitMs === 'number' && cooldownResult.waitMs > 0, 'cooldown runtime result should expose positive waitMs');
    assert(cooldownResult.recoveryStatus?.waitMs === cooldownResult.waitMs, 'cooldown runtime result should align top-level waitMs with recoveryStatus.waitMs');
    assert(typeof cooldownResult.nextEligibleRetryAt === 'string' && cooldownResult.nextEligibleRetryAt.length > 0, 'cooldown runtime result should expose nextEligibleRetryAt');
    assert(cooldownResult.recovery?.nextEligibleRetryAt === cooldownResult.nextEligibleRetryAt, 'cooldown runtime result should align recovery nextEligibleRetryAt with top-level value');
    assert(cooldownResult.recoveryStatus?.nextEligibleRetryAt === cooldownResult.nextEligibleRetryAt, 'cooldown runtime result should align recoveryStatus nextEligibleRetryAt with top-level value');

    const cooldownState = await runClaudeRuntimeCli('get-workflow-state', {
      workflowId: 'claude-runtime-transient-cooldown-workflow'
    }, cooldownProfile);
    const cooldownTask = Array.isArray(cooldownState.tasks) ? cooldownState.tasks[0] : null;
    assert(cooldownState.workflow?.status === 'blocked', 'cooldown runtime workflow should remain blocked until eligible retry time');
    assert(cooldownTask?.status === 'blocked', 'cooldown runtime task should remain blocked during cooldown');
    assert(cooldownTask?.reasonCode === 'runner_execution_failed', 'cooldown runtime task should persist terminal retry-exhaustion reason code');
    assert(cooldownTask?.lastError?.includes('API Error: 502'), 'cooldown runtime task should preserve upstream API 502 detail');
    assert(cooldownTask?.attemptCount === 1, 'cooldown runtime task should preserve failed attempt count');
    assert(cooldownTask?.recovery?.recoveryClass === 'transient_upstream', 'cooldown runtime task should persist transient recovery metadata');
    assert(cooldownTask?.recovery?.recoverySource === 'claude_runtime', 'cooldown runtime task should persist recovery source');
    assert(cooldownTask?.recovery?.retryBudget?.remainingRetries === 0, 'cooldown runtime task should persist exhausted retry budget');
    assert(cooldownTask?.recovery?.cooldownMs === cooldownResult.recovery?.cooldownMs, 'cooldown runtime task should persist the same cooldownMs returned by the loop');
    assert(cooldownTask?.recovery?.nextEligibleRetryAt === cooldownResult.nextEligibleRetryAt, 'cooldown runtime task should persist nextEligibleRetryAt');

    const resumedResult = await runJsonScript(runScriptPath, [
      '--resume',
      '--assignment-id',
      blockedResult.assignment.assignmentId
    ], baseEnv);
    assert(resumedResult.command === 'resume-assigned-work', 'resume mode should call the coordinator resume command');
    assert(resumedResult.status === 'done', 'resume mode should complete blocked work when the adapter returns done');

    const resumedState = await runClaudeRuntimeCli('get-workflow-state', {
      workflowId: 'claude-runtime-blocked-workflow'
    }, profile);
    assert(resumedState.workflow?.status === 'done', 'blocked workflow should finish after resume through the runtime wrapper');
  } finally {
    await stopBackgroundScript(ops.child);
  }

  console.log('claude runtime smoke test passed');
}

function createRuntimeEnv(overrides = {}) {
  return {
    ...process.env,
    WORKFLOW_CLOSURE_CLAUDE_WORKSPACE_PATH: rootDir,
    WORKFLOW_CLOSURE_CLAUDE_DB_PATH: dbPath,
    WORKFLOW_CLOSURE_CLAUDE_COMMAND: process.execPath,
    WORKFLOW_CLOSURE_CLAUDE_ARGS_JSON: JSON.stringify([fixturePath, '--print']),
    WORKFLOW_CLOSURE_CLAUDE_PORT: String(port),
    ...overrides
  };
}

async function runJsonScript(scriptPath, args, env) {
  const result = await runScript(scriptPath, args, env);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${path.basename(scriptPath)}: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`);
  }
}

async function runScript(scriptPath, args, env) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: rootDir,
      env,
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
    throw new Error(result.stderr || result.stdout || `${path.basename(scriptPath)} failed`);
  }

  return result;
}

async function startBackgroundScript(scriptPath, env, readyPattern) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: rootDir,
    env,
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

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${path.basename(scriptPath)} to become ready.\n${stdout}\n${stderr}`));
    }, 15000);

    const onData = (chunk) => {
      stdout += String(chunk);
      if (readyPattern.test(stdout)) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve();
      }
    };

    child.stdout.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      reject(new Error(`${path.basename(scriptPath)} exited early with code ${code}.\n${stdout}\n${stderr}`));
    });
  });

  return { child };
}

async function stopBackgroundScript(child) {
  if (!child || child.exitCode != null) {
    return;
  }

  await new Promise((resolve) => {
    const done = () => resolve();
    child.once('close', done);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode == null) {
        child.kill('SIGKILL');
      }
    }, 3000);
  });
}

async function requestJson(url) {
  const body = await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${text}`));
          return;
        }
        resolve(text);
      });
    });
    request.on('error', reject);
  });

  return JSON.parse(body);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await closeDb();
});
