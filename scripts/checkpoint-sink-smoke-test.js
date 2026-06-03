import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createCheckpointSink,
  createGitCheckpointSink,
  createWorkflowEngine,
  createWorkflowRunner
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'checkpoint-sink-smoke-test.db');
const repoRoot = path.join(__dirname, 'tmp-checkpoint-sink-repos');
const gitIdentity = {
  GIT_AUTHOR_NAME: 'Workflow Closure',
  GIT_AUTHOR_EMAIL: 'workflow-closure@example.com',
  GIT_COMMITTER_NAME: 'Workflow Closure',
  GIT_COMMITTER_EMAIL: 'workflow-closure@example.com'
};

async function main() {
  await fs.rm(dbPath, { force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
  await fs.mkdir(repoRoot, { recursive: true });

  await testFunctionCheckpointDone();
  await testFunctionCheckpointBlocked();
  await testFunctionCheckpointError();
  await testGitCheckpointWritten();
  await testGitCheckpointSkippedWithoutChanges();
  await testGitCheckpointSkippedWhenBlocked();

  console.log('checkpoint-sink smoke test passed');
}

async function testFunctionCheckpointDone() {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = createSingleTaskWorkflow(engine, {
    instruction: '验证自定义 checkpoint sink 会记录 done 结果',
    title: '执行 done checkpoint sink'
  });
  const calls = [];
  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'checkpoint-function-done',
    checkpointSink: createCheckpointSink(async (input) => {
      calls.push(input);
      return {
        status: 'written',
        summary: `Captured ${input.task.taskId}`,
        metadata: {
          checkpointSink: 'custom-function',
          resultStatus: input.result.status,
          workflowId: input.workflow.workflowId
        },
        payload: {
          taskId: input.task.taskId
        }
      };
    }),
    adapter: async ({ task }) => ({
      status: 'done',
      doneSummary: `已完成：${task.title}`,
      payload: {
        adapterTaskId: task.taskId
      }
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');

  assert(step.status === 'done', 'function checkpoint done path should stay done');
  assert(calls.length === 1, 'function checkpoint sink should be invoked once on done path');
  assert(calls[0].result.status === 'done', 'function checkpoint sink should receive finalized done result');
  assert(step.checkpoint?.status === 'written', 'function checkpoint done path should expose checkpoint result');
  assert(step.checkpoint?.metadata?.resultStatus === 'done', 'function checkpoint done path should preserve metadata');
  assert(completionLog?.payload?.checkpoint?.status === 'written', 'function checkpoint done log should persist checkpoint result');
  assert(completionLog?.payload?.checkpoint?.payload?.taskId === step.task.taskId, 'function checkpoint done log should persist checkpoint payload');
}

async function testFunctionCheckpointBlocked() {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = createSingleTaskWorkflow(engine, {
    instruction: '验证自定义 checkpoint sink 会记录 blocked 结果',
    title: '执行 blocked checkpoint sink'
  });
  const calls = [];
  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'checkpoint-function-blocked',
    checkpointSink: createCheckpointSink(async (input) => {
      calls.push(input);
      return {
        status: 'written',
        summary: `Blocked ${input.task.taskId}`,
        metadata: {
          checkpointSink: 'custom-function',
          resultStatus: input.result.status
        }
      };
    }),
    adapter: async ({ task }) => ({
      status: 'blocked',
      blockedReason: `等待外部依赖：${task.title}`,
      payload: {
        adapterTaskId: task.taskId
      }
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'function checkpoint blocked path should stay blocked');
  assert(calls.length === 1, 'function checkpoint sink should be invoked once on blocked path');
  assert(calls[0].result.status === 'blocked', 'function checkpoint sink should receive finalized blocked result');
  assert(step.checkpoint?.status === 'written', 'function checkpoint blocked path should expose checkpoint result');
  assert(blockedLog?.payload?.checkpoint?.status === 'written', 'function checkpoint blocked log should persist checkpoint result');
  assert(blockedLog?.payload?.checkpoint?.metadata?.resultStatus === 'blocked', 'function checkpoint blocked log should persist blocked metadata');
}

async function testFunctionCheckpointError() {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = createSingleTaskWorkflow(engine, {
    instruction: '验证自定义 checkpoint sink 会记录 runner error 结果',
    title: '执行 error checkpoint sink'
  });
  const calls = [];
  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'checkpoint-function-error',
    maxTaskRetries: 0,
    checkpointSink: createCheckpointSink(async (input) => {
      calls.push(input);
      return {
        status: 'written',
        summary: `Error ${input.task.taskId}`,
        metadata: {
          checkpointSink: 'custom-function',
          resultStatus: input.result.status,
          error: input.error || null
        }
      };
    }),
    adapter: async ({ task }) => {
      throw new Error(`runner boom: ${task.title}`);
    }
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const errorLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_runner_error');

  assert(step.status === 'blocked', 'function checkpoint error path should return blocked');
  assert(calls.length === 1, 'function checkpoint sink should be invoked once on error path');
  assert(calls[0].result.status === 'blocked', 'function checkpoint sink should receive blocked result on error path');
  assert(calls[0].error === `runner boom: ${step.task.title}`, 'function checkpoint sink should receive runner error text');
  assert(step.checkpoint?.status === 'written', 'function checkpoint error path should expose checkpoint result');
  assert(errorLog?.payload?.checkpoint?.status === 'written', 'function checkpoint error log should persist checkpoint result');
  assert(errorLog?.payload?.checkpoint?.metadata?.error === `runner boom: ${step.task.title}`, 'function checkpoint error log should persist runner error metadata');
}

async function testGitCheckpointWritten() {
  const repoDir = await createTempGitRepo('written');
  const initialHead = await getHeadSha(repoDir);
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = createSingleTaskWorkflow(engine, {
    instruction: '验证 git checkpoint sink 会提交变更',
    title: '写入 git checkpoint'
  });
  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'checkpoint-git-written',
    checkpointSink: createGitCheckpointSink({
      cwd: repoDir,
      authorName: gitIdentity.GIT_AUTHOR_NAME,
      authorEmail: gitIdentity.GIT_AUTHOR_EMAIL
    }),
    adapter: async ({ task }) => {
      await fs.writeFile(
        path.join(repoDir, 'task-output.txt'),
        [`taskId=${task.taskId}`, `workflowId=${workflow.workflow.workflowId}`, `title=${task.title}`].join('\n'),
        'utf8'
      );

      return {
        status: 'done',
        doneSummary: `已写入变更：${task.title}`
      };
    }
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');
  const head = await getHeadSha(repoDir);
  const commitMessage = (await runGit(repoDir, ['log', '-1', '--pretty=%B'])).stdout;

  assert(step.status === 'done', 'git checkpoint written path should stay done');
  assert(step.checkpoint?.status === 'written', 'git checkpoint written path should expose written status');
  assert(step.checkpoint?.artifactRef === `git:${head}`, 'git checkpoint written path should expose git artifact ref');
  assert(step.checkpoint?.metadata?.commitSha === head, 'git checkpoint written path should expose commit sha');
  assert(head !== initialHead, 'git checkpoint written path should create a new commit');
  assert(commitMessage.includes(step.task.title), 'git checkpoint commit message should include task title');
  assert(commitMessage.includes(workflow.workflow.workflowId), 'git checkpoint commit message should include workflow id');
  assert(commitMessage.includes(step.task.taskId), 'git checkpoint commit message should include task id');
  assert(completionLog?.payload?.checkpoint?.metadata?.commitSha === head, 'git checkpoint completion log should persist commit sha');
}

async function testGitCheckpointSkippedWithoutChanges() {
  const repoDir = await createTempGitRepo('no-change');
  const initialHead = await getHeadSha(repoDir);
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = createSingleTaskWorkflow(engine, {
    instruction: '验证 git checkpoint sink 在无变更时跳过',
    title: '无变更 git checkpoint'
  });
  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'checkpoint-git-no-change',
    checkpointSink: createGitCheckpointSink({
      cwd: repoDir,
      authorName: gitIdentity.GIT_AUTHOR_NAME,
      authorEmail: gitIdentity.GIT_AUTHOR_EMAIL
    }),
    adapter: async ({ task }) => ({
      status: 'done',
      doneSummary: `无需变更：${task.title}`
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');
  const head = await getHeadSha(repoDir);

  assert(step.status === 'done', 'git checkpoint no-change path should stay done');
  assert(step.checkpoint?.status === 'skipped', 'git checkpoint no-change path should be skipped');
  assert(step.checkpoint?.summary.includes('no working tree changes'), 'git checkpoint no-change path should explain skip reason');
  assert(head === initialHead, 'git checkpoint no-change path should not create a new commit');
  assert(completionLog?.payload?.checkpoint?.status === 'skipped', 'git checkpoint no-change log should persist skipped status');
}

async function testGitCheckpointSkippedWhenBlocked() {
  const repoDir = await createTempGitRepo('blocked');
  const initialHead = await getHeadSha(repoDir);
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = createSingleTaskWorkflow(engine, {
    instruction: '验证 git checkpoint sink 在 blocked 时跳过',
    title: 'blocked git checkpoint'
  });
  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId: 'checkpoint-git-blocked',
    checkpointSink: createGitCheckpointSink({
      cwd: repoDir,
      authorName: gitIdentity.GIT_AUTHOR_NAME,
      authorEmail: gitIdentity.GIT_AUTHOR_EMAIL
    }),
    adapter: async ({ task }) => ({
      status: 'blocked',
      blockedReason: `等待输入：${task.title}`
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');
  const head = await getHeadSha(repoDir);

  assert(step.status === 'blocked', 'git checkpoint blocked path should stay blocked');
  assert(step.checkpoint?.status === 'skipped', 'git checkpoint blocked path should be skipped');
  assert(step.checkpoint?.summary.includes('did not finish as done'), 'git checkpoint blocked path should explain skip reason');
  assert(step.checkpoint?.metadata?.resultStatus === 'blocked', 'git checkpoint blocked path should persist blocked result status');
  assert(head === initialHead, 'git checkpoint blocked path should not create a new commit');
  assert(blockedLog?.payload?.checkpoint?.status === 'skipped', 'git checkpoint blocked log should persist skipped status');
}

function createSingleTaskWorkflow(engine, { instruction, title, description }) {
  return engine.createWorkflowFromInstruction({
    instruction,
    plan: {
      goal: instruction,
      steps: [
        {
          key: 'step-1',
          title,
          description: description || title
        }
      ],
      dependencies: []
    }
  });
}

async function createTempGitRepo(name) {
  const repoDir = path.join(repoRoot, name);
  await fs.rm(repoDir, { recursive: true, force: true });
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf8');

  await runGitChecked(repoDir, ['init']);
  await runGitChecked(repoDir, ['add', 'README.md']);
  await runGitChecked(repoDir, ['commit', '-m', `init ${name}`], gitIdentity);

  return repoDir;
}

async function getHeadSha(repoDir) {
  const result = await runGit(repoDir, ['rev-parse', 'HEAD']);
  assert(result.exitCode === 0, `expected git rev-parse HEAD to succeed for ${repoDir}`);
  return result.stdout;
}

async function runGitChecked(repoDir, args, env) {
  const result = await runGit(repoDir, args, env);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${repoDir}: ${result.stderr || result.stdout || 'unknown error'}`);
  }
  return result;
}

async function runGit(repoDir, args, env) {
  return runCommand('git', args, {
    cwd: repoDir,
    env: env ? { ...process.env, ...env } : process.env
  });
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd || undefined,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
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
    await fs.rm(repoRoot, { recursive: true, force: true }).catch(() => {});
    closeDb();
  });
