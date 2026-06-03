/**
 * 并发压力测试 - 验证 busy_timeout 是否能解决多进程并发写入冲突
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const cliPath = path.join(rootDir, 'cli.js');

async function runCli(command, input = {}, options = {}) {
  const args = [cliPath, command, '--input', JSON.stringify(input)];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr || stdout, stderr, stdout, code, expectedFailure: options.allowFailure === true });
      } else {
        try {
          resolve({ success: true, data: JSON.parse(stdout), stderr, stdout, code: 0 });
        } catch {
          resolve({ success: true, data: stdout, stderr, stdout, code: 0 });
        }
      }
    });
  });
}

// ============ 测试 1: 多个进程同时 claim 任务 ============
async function testConcurrentClaims() {
  console.log('\n[Test 1] 5 个进程同时 claim 任务...');
  const db = path.join(__dirname, 'concurrency-test-claim.db');
  await fs.rm(db, { force: true });

  // 创建工作流，包含 3 个无依赖的 ready 任务
  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '并发 claim 测试',
    concurrencyLimit: 3,
    plan: {
      goal: '并发测试',
      steps: [
        { key: 's1', title: '任务1', type: 'implement' },
        { key: 's2', title: '任务2', type: 'implement' },
        { key: 's3', title: '任务3', type: 'implement' }
      ],
      dependencies: []
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  // 5 个进程同时 claim
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(runCli('claim-next-ready-task', {
      dbPath: db,
      leaseOwner: `runner-${i}`,
      leaseMs: 60000
    }));
  }

  const results = await Promise.all(promises);
  const claimed = results.filter(r => r.success && r.data?.status === 'claimed');
  const idle = results.filter(r => r.success && r.data?.status === 'idle');
  const failed = results.filter(r => !r.success);

  console.log(`  claimed: ${claimed.length}, idle: ${idle.length}, failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log(`  错误示例: ${failed[0]?.error?.substring(0, 200)}`);
  }

  // 显式 concurrencyLimit=3 时，同一 workflow 最多允许 3 个 doing 任务
  // 期望：3 个 claimed，2 个 idle，0 个 failed
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个进程因 database locked 失败`);
  }
  if (claimed.length !== 3) {
    throw new Error(`期望 3 个 claimed（concurrencyLimit=3），实际 ${claimed.length}`);
  }
  if (idle.length !== 2) {
    throw new Error(`期望 2 个 idle，实际 ${idle.length}`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

async function testDefaultConcurrencyLimit() {
  console.log('\n[Test 2] 默认 concurrencyLimit 保持单任务执行...');
  const db = path.join(__dirname, 'concurrency-test-default-limit.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '默认并发限制测试',
    plan: {
      goal: '默认并发限制',
      steps: [
        { key: 's1', title: '任务1', type: 'implement' },
        { key: 's2', title: '任务2', type: 'implement' }
      ],
      dependencies: []
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const [first, second] = await Promise.all([
    runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'default-1', leaseMs: 60000 }),
    runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'default-2', leaseMs: 60000 })
  ]);

  const claimed = [first, second].filter(r => r.success && r.data?.status === 'claimed');
  const idle = [first, second].filter(r => r.success && r.data?.status === 'idle');
  const failed = [first, second].filter(r => !r.success);
  console.log(`  claimed: ${claimed.length}, idle: ${idle.length}, failed: ${failed.length}`);

  if (failed.length > 0) {
    throw new Error(`${failed.length} 个进程因 database locked 失败`);
  }
  if (claimed.length !== 1) {
    throw new Error(`默认 concurrencyLimit 应只允许 1 个 claimed，实际 ${claimed.length}`);
  }
  if (idle.length !== 1) {
    throw new Error(`默认 concurrencyLimit 应产生 1 个 idle，实际 ${idle.length}`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

async function testDependencyGateWithConcurrency() {
  console.log('\n[Test 3] concurrencyLimit>1 时依赖仍阻止后继 claim...');
  const db = path.join(__dirname, 'concurrency-test-dependency-gate.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '并发依赖门控测试',
    concurrencyLimit: 2,
    plan: {
      goal: '依赖门控',
      steps: [
        { key: 's1', title: '前置任务', type: 'implement' },
        { key: 's2', title: '后继任务', type: 'implement' }
      ],
      dependencies: [
        { predecessor: 's1', successor: 's2' }
      ]
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const first = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'dep-1', leaseMs: 60000 });
  if (!first.success || first.data?.status !== 'claimed') {
    throw new Error(`第一个 claim 应成功，实际 ${first.error || first.data?.status}`);
  }

  const second = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'dep-2', leaseMs: 60000 });
  if (!second.success) {
    throw new Error(`第二个 claim 不应失败: ${second.error}`);
  }
  if (second.data?.status !== 'idle') {
    throw new Error(`后继任务依赖未完成时应 idle，实际 ${second.data?.status}`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}


async function testConcurrentHeartbeats() {
  console.log('\n[Test 2] 5 个进程同时 heartbeat...');
  const db = path.join(__dirname, 'concurrency-test-hb.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '并发 heartbeat 测试',
    plan: {
      goal: 'hb测试',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 5000
  });
  if (!claim.success) throw new Error(`claim 失败: ${claim.error}`);

  // 5 个进程同时 heartbeat
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(runCli('heartbeat-task-lease', {
      dbPath: db,
      workflowId: claim.data.task.workflowId,
      taskId: claim.data.task.taskId,
      leaseOwner: 'runner',
      leaseMs: 10000
    }));
  }

  const results = await Promise.all(promises);
  const renewed = results.filter(r => r.success && r.data?.status === 'renewed');
  const failed = results.filter(r => !r.success);

  console.log(`  renewed: ${renewed.length}, failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log(`  错误示例: ${failed[0]?.error?.substring(0, 200)}`);
  }

  // 期望：5 个都成功（至少 1 个 renewed，其他的可能也是 renewed 或返回正确状态）
  if (failed.length > 0) {
    throw new Error(`${failed.length} 个进程因 database locked 失败`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 3: 混合读写操作 ============
async function testMixedOperations() {
  console.log('\n[Test 3] 10 个进程混合读写...');
  const db = path.join(__dirname, 'concurrency-test-mixed.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '混合并发测试',
    plan: {
      goal: '混合',
      steps: [
        { key: 's1', title: '任务1', type: 'implement' },
        { key: 's2', title: '任务2', type: 'implement' }
      ],
      dependencies: []
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const wfId = created.data.workflow.workflowId;

  // 10 个进程执行不同操作
  const operations = [
    () => runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'r1', leaseMs: 60000 }),
    () => runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'r2', leaseMs: 60000 }),
    () => runCli('get-workflow-state', { dbPath: db, workflowId: wfId }),
    () => runCli('get-workflow-state', { dbPath: db, workflowId: wfId }),
    () => runCli('release-expired-leases', { dbPath: db, reason: 'test' }),
    () => runCli('get-workflow-state', { dbPath: db, workflowId: wfId }),
    () => runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'r3', leaseMs: 60000 }),
    () => runCli('get-workflow-state', { dbPath: db, workflowId: wfId }),
    () => runCli('release-expired-leases', { dbPath: db, reason: 'test2' }),
    () => runCli('get-workflow-state', { dbPath: db, workflowId: wfId }),
  ];

  const results = await Promise.all(operations.map(op => op()));
  const failed = results.filter(r => !r.success);

  console.log(`  总操作: ${results.length}, 失败: ${failed.length}`);
  if (failed.length > 0) {
    console.log(`  错误示例: ${failed[0]?.error?.substring(0, 200)}`);
  }

  if (failed.length > 0) {
    throw new Error(`${failed.length} 个操作因 database locked 失败`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

async function testFinalizeConflictRace() {
  console.log('\n[Test 4] 2 个进程同时 finalize 同一任务...');
  const db = path.join(__dirname, 'concurrency-test-finalize.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '并发 finalize 冲突测试',
    plan: {
      goal: 'finalize 冲突',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const claim = await runCli('claim-next-ready-task', {
    dbPath: db,
    leaseOwner: 'runner',
    leaseMs: 60000
  });
  if (!claim.success || claim.data?.status !== 'claimed') {
    throw new Error(`claim 失败: ${claim.error || 'unknown error'}`);
  }

  const workflowId = claim.data.task.workflowId;
  const taskId = claim.data.task.taskId;
  const [complete, block] = await Promise.all([
    runCli('complete-task', {
      dbPath: db,
      workflowId,
      taskId,
      doneSummary: '并发完成',
      leaseOwner: 'runner'
    }, { allowFailure: true }),
    runCli('block-task', {
      dbPath: db,
      workflowId,
      taskId,
      blockedReason: '并发阻塞',
      leaseOwner: 'runner'
    }, { allowFailure: true })
  ]);

  const successes = [complete, block].filter((result) => result.success);
  const failures = [complete, block].filter((result) => !result.success);
  console.log(`  success: ${successes.length}, failed: ${failures.length}`);

  if (successes.length !== 1) {
    throw new Error(`期望只有 1 个 finalize 成功，实际 ${successes.length}`);
  }
  if (failures.length !== 1) {
    throw new Error(`期望只有 1 个 finalize 失败，实际 ${failures.length}`);
  }

  const state = await runCli('get-workflow-state', { dbPath: db, workflowId });
  if (!state.success) throw new Error(`读取状态失败: ${state.error}`);

  const task = state.data.tasks.find((item) => item.taskId === taskId);
  if (!task) throw new Error('未找到目标任务');
  if (!['done', 'blocked'].includes(task.status)) {
    throw new Error(`任务最终状态应为 done 或 blocked，实际 ${task.status}`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

async function testConcurrentAddTaskOutputs() {
  console.log('\n[Test 5] 5 个进程同时写入 task output...');
  const db = path.join(__dirname, 'concurrency-test-task-output.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '并发 task output 测试',
    plan: {
      goal: 'task output 并发',
      steps: [{ key: 's1', title: '输出任务', type: 'implement' }],
      dependencies: []
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const claim = await runCli('claim-next-ready-task', {
    dbPath: db,
    leaseOwner: 'output-runner',
    leaseMs: 60000
  });
  if (!claim.success || claim.data?.status !== 'claimed') {
    throw new Error(`claim 失败: ${claim.error || claim.data?.status}`);
  }

  const workflowId = claim.data.task.workflowId;
  const taskId = claim.data.task.taskId;
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => runCli('add-task-output', {
    dbPath: db,
    workflowId,
    taskId,
    kind: 'result',
    name: `output-${index}`,
    content: `并发输出 ${index}`,
    metadata: { source: 'concurrency-stress-test', index }
  })));

  const failed = results.filter((result) => !result.success);
  console.log(`  success: ${results.length - failed.length}, failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log(`  错误示例: ${failed[0]?.error?.substring(0, 200)}`);
    throw new Error(`${failed.length} 个 add-task-output 因 database locked 失败`);
  }

  const outputs = await runCli('list-task-outputs', {
    dbPath: db,
    workflowId,
    taskId,
    kind: 'result',
    limit: 10
  });
  if (!outputs.success) throw new Error(`读取 output 失败: ${outputs.error}`);

  if (outputs.data?.outputs?.length !== 5) {
    throw new Error(`期望写入 5 条 task output，实际 ${outputs.data?.outputs?.length ?? 0}`);
  }

  const outputNames = new Set(outputs.data.outputs.map((item) => item.name));
  for (let index = 0; index < 5; index++) {
    if (!outputNames.has(`output-${index}`)) {
      throw new Error(`缺少 output-${index} 的并发写入结果`);
    }
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

async function testConcurrentResumeTask() {
  console.log('\n[Test 6] 3 个进程同时 resume 同一 blocked 任务...');
  const db = path.join(__dirname, 'concurrency-test-resume.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '并发 resume 测试',
    plan: {
      goal: 'resume 并发',
      steps: [{ key: 's1', title: '待恢复任务', type: 'implement' }],
      dependencies: []
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const claim = await runCli('claim-next-ready-task', {
    dbPath: db,
    leaseOwner: 'resume-runner',
    leaseMs: 60000
  });
  if (!claim.success || claim.data?.status !== 'claimed') {
    throw new Error(`claim 失败: ${claim.error || claim.data?.status}`);
  }

  const workflowId = claim.data.task.workflowId;
  const taskId = claim.data.task.taskId;
  const blocked = await runCli('block-task', {
    dbPath: db,
    workflowId,
    taskId,
    blockedReason: '等待人工恢复',
    leaseOwner: 'resume-runner'
  });
  if (!blocked.success || blocked.data?.status !== 'updated' || blocked.data?.task?.status !== 'blocked') {
    throw new Error(`block 失败: ${blocked.error || blocked.data?.status}`);
  }

  const results = await Promise.all(Array.from({ length: 3 }, (_, index) => runCli('resume-task', {
    dbPath: db,
    workflowId,
    taskId,
    payload: { source: 'concurrency-stress-test', index }
  }, { allowFailure: true })));

  const successes = results.filter((result) => result.success);
  const failures = results.filter((result) => !result.success);
  const lockFailures = failures.filter((result) => /database is locked|SQLITE_BUSY/i.test(result.error || ''));
  console.log(`  success: ${successes.length}, failed: ${failures.length}`);

  if (lockFailures.length > 0) {
    throw new Error(`${lockFailures.length} 个 resume-task 因 database locked 失败`);
  }
  if (successes.length !== 1) {
    throw new Error(`期望只有 1 个 resume-task 成功，实际 ${successes.length}`);
  }
  if (failures.length !== 2) {
    throw new Error(`期望只有 2 个 resume-task 失败，实际 ${failures.length}`);
  }
  if (!failures.every((result) => (result.error || '').includes('Only blocked tasks can be resumed.'))) {
    throw new Error(`resume-task 并发失败原因异常: ${failures[0]?.error || 'unknown error'}`);
  }

  const state = await runCli('get-workflow-state', { dbPath: db, workflowId });
  if (!state.success) throw new Error(`读取状态失败: ${state.error}`);

  const task = state.data.tasks.find((item) => item.taskId === taskId);
  if (!task) throw new Error('未找到目标任务');
  if (task.status !== 'ready') {
    throw new Error(`恢复后的任务应为 ready，实际 ${task.status}`);
  }
  if (task.attemptCount !== blocked.data.task.attemptCount) {
    throw new Error(`resume-task 应保留 attemptCount，实际 ${task.attemptCount}`);
  }
  if (task.lastError !== '等待人工恢复') {
    throw new Error(`resume-task 应保留 lastError，实际 ${task.lastError}`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

async function testConcurrentRestartFromTask() {
  console.log('\n[Test 7] 2 个进程同时 restart 同一任务...');
  const db = path.join(__dirname, 'concurrency-test-restart.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '并发 restart-from-task 测试',
    plan: {
      goal: 'restart 并发',
      steps: [
        { key: 's1', title: '改写错误结论', type: 'implement' },
        { key: 's2', title: '重新发布结果', type: 'handoff' }
      ],
      dependencies: [
        { predecessor: 's1', successor: 's2' }
      ]
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const firstClaim = await runCli('claim-next-ready-task', {
    dbPath: db,
    leaseOwner: 'restart-runner',
    leaseMs: 60000
  });
  if (!firstClaim.success || firstClaim.data?.status !== 'claimed') {
    throw new Error(`首次 claim 失败: ${firstClaim.error || firstClaim.data?.status}`);
  }

  const workflowId = firstClaim.data.task.workflowId;
  await runCli('complete-task', {
    dbPath: db,
    workflowId,
    taskId: firstClaim.data.task.taskId,
    doneSummary: '完成起点任务',
    leaseOwner: 'restart-runner'
  });

  const secondClaim = await runCli('claim-next-ready-task', {
    dbPath: db,
    workflowId,
    leaseOwner: 'restart-runner',
    leaseMs: 60000
  });
  if (!secondClaim.success || secondClaim.data?.status !== 'claimed') {
    throw new Error(`第二次 claim 失败: ${secondClaim.error || secondClaim.data?.status}`);
  }

  await runCli('complete-task', {
    dbPath: db,
    workflowId,
    taskId: secondClaim.data.task.taskId,
    doneSummary: '完成下游任务',
    leaseOwner: 'restart-runner'
  });

  const finishedState = await runCli('get-workflow-state', { dbPath: db, workflowId });
  if (!finishedState.success) throw new Error(`读取完成态失败: ${finishedState.error}`);

  const originTask = finishedState.data.tasks.find((item) => item.title === '改写错误结论');
  const descendantTask = finishedState.data.tasks.find((item) => item.title === '重新发布结果');
  if (!originTask || !descendantTask) {
    throw new Error('未找到 restart-from-task 测试所需任务');
  }

  const reason = '并发 rerun 修正错误结论';
  const fingerprint = 'concurrency-restart';
  const results = await Promise.all([
    runCli('restart-from-task', {
      dbPath: db,
      workflowId,
      taskId: originTask.taskId,
      reason,
      fingerprint,
      operator: 'concurrency-stress-test',
      maxSameFingerprintReruns: 1
    }, { allowFailure: true }),
    runCli('restart-from-task', {
      dbPath: db,
      workflowId,
      taskId: originTask.taskId,
      reason,
      fingerprint,
      operator: 'concurrency-stress-test',
      maxSameFingerprintReruns: 1
    }, { allowFailure: true })
  ]);

  const successes = results.filter((result) => result.success);
  const failures = results.filter((result) => !result.success);
  const lockFailures = failures.filter((result) => /database is locked|SQLITE_BUSY/i.test(result.error || ''));
  console.log(`  success: ${successes.length}, failed: ${failures.length}`);

  if (lockFailures.length > 0) {
    throw new Error(`${lockFailures.length} 个 restart-from-task 因 database locked 失败`);
  }
  if (successes.length !== 1) {
    throw new Error(`期望只有 1 个 restart-from-task 成功，实际 ${successes.length}`);
  }
  if (failures.length !== 1) {
    throw new Error(`期望只有 1 个 restart-from-task 失败，实际 ${failures.length}`);
  }
  if (!failures.every((result) => (result.error || '').includes('Rerun budget exceeded'))) {
    throw new Error(`restart-from-task 并发失败原因异常: ${failures[0]?.error || 'unknown error'}`);
  }

  const restartedState = await runCli('get-workflow-state', { dbPath: db, workflowId });
  if (!restartedState.success) throw new Error(`读取重跑状态失败: ${restartedState.error}`);

  const restartedOrigin = restartedState.data.tasks.find((item) => item.taskId === originTask.taskId);
  const restartedDescendant = restartedState.data.tasks.find((item) => item.taskId === descendantTask.taskId);
  if (restartedOrigin?.status !== 'ready') {
    throw new Error(`重跑起点任务应回到 ready，实际 ${restartedOrigin?.status}`);
  }
  if (restartedOrigin?.attemptCount !== 0) {
    throw new Error(`重跑起点任务应重置 attemptCount，实际 ${restartedOrigin?.attemptCount}`);
  }
  if (restartedDescendant?.status !== 'pending') {
    throw new Error(`重跑下游任务应回到 pending，实际 ${restartedDescendant?.status}`);
  }
  if (restartedDescendant?.attemptCount !== 0) {
    throw new Error(`重跑下游任务应重置 attemptCount，实际 ${restartedDescendant?.attemptCount}`);
  }

  const reruns = await runCli('list-workflow-reruns', {
    dbPath: db,
    workflowId,
    limit: 10
  });
  if (!reruns.success) throw new Error(`读取 rerun 审计失败: ${reruns.error}`);
  if (reruns.data?.reruns?.length !== 1) {
    throw new Error(`期望仅创建 1 条 rerun 记录，实际 ${reruns.data?.reruns?.length ?? 0}`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

async function testSweepTaskTimeouts() {
  console.log('\n[Test 8] sweep-task-timeouts 回收超时任务...');
  const db = path.join(__dirname, 'concurrency-test-timeout-sweep.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '超时 sweep 测试',
    plan: {
      goal: '超时 sweep',
      steps: [{ key: 's1', title: '超时任务', type: 'implement' }],
      dependencies: []
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const claim = await runCli('claim-next-ready-task', {
    dbPath: db,
    leaseOwner: 'timeout-runner',
    leaseMs: 60000
  });
  if (!claim.success || claim.data?.status !== 'claimed') {
    throw new Error(`claim 失败: ${claim.error || claim.data?.status}`);
  }

  const now = new Date(Date.now() + 120000).toISOString();
  const sweep = await runCli('sweep-task-timeouts', {
    dbPath: db,
    workflowId: claim.data.task.workflowId,
    now,
    maxExecutionMs: 1000,
    maxAttempts: 2,
    reason: 'timeout sweep test'
  });
  if (!sweep.success) throw new Error(`sweep 失败: ${sweep.error}`);
  if (sweep.data?.releasedTaskCount !== 1) {
    throw new Error(`期望释放 1 个超时任务，实际 ${sweep.data?.releasedTaskCount}`);
  }

  const state = await runCli('get-workflow-state', {
    dbPath: db,
    workflowId: claim.data.task.workflowId
  });
  if (!state.success) throw new Error(`读取状态失败: ${state.error}`);
  const task = state.data.tasks.find((item) => item.taskId === claim.data.task.taskId);
  if (task?.status !== 'ready') {
    throw new Error(`超时任务应回到 ready，实际 ${task?.status}`);
  }
  if (task?.reasonCode !== 'runner_execution_timeout') {
    throw new Error(`超时任务 reasonCode 应为 runner_execution_timeout，实际 ${task?.reasonCode}`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

async function testSweepTaskTimeoutExhaustion() {
  console.log('\n[Test 8] sweep-task-timeouts 耗尽后阻塞任务...');
  const db = path.join(__dirname, 'concurrency-test-timeout-sweep-block.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '超时 sweep 阻塞测试',
    plan: {
      goal: '超时 sweep block',
      steps: [{ key: 's1', title: '阻塞任务', type: 'implement' }],
      dependencies: []
    }
  });
  if (!created.success) throw new Error(`创建失败: ${created.error}`);

  const claim = await runCli('claim-next-ready-task', {
    dbPath: db,
    leaseOwner: 'timeout-block-runner',
    leaseMs: 60000
  });
  if (!claim.success || claim.data?.status !== 'claimed') {
    throw new Error(`claim 失败: ${claim.error || claim.data?.status}`);
  }

  const sweep = await runCli('sweep-task-timeouts', {
    dbPath: db,
    workflowId: claim.data.task.workflowId,
    now: new Date(Date.now() + 120000).toISOString(),
    maxExecutionMs: 1000,
    maxAttempts: 1,
    reason: 'timeout sweep exhausted test'
  });
  if (!sweep.success) throw new Error(`sweep 失败: ${sweep.error}`);
  if (sweep.data?.blockedTaskCount !== 1) {
    throw new Error(`期望阻塞 1 个超时任务，实际 ${sweep.data?.blockedTaskCount}`);
  }

  const state = await runCli('get-workflow-state', {
    dbPath: db,
    workflowId: claim.data.task.workflowId
  });
  if (!state.success) throw new Error(`读取状态失败: ${state.error}`);
  const task = state.data.tasks.find((item) => item.taskId === claim.data.task.taskId);
  if (task?.status !== 'blocked') {
    throw new Error(`超时耗尽任务应 blocked，实际 ${task?.status}`);
  }

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}
async function main() {
  const tests = [
    testConcurrentClaims,
    testDefaultConcurrencyLimit,
    testDependencyGateWithConcurrency,
    testConcurrentHeartbeats,
    testMixedOperations,
    testFinalizeConflictRace,
    testConcurrentAddTaskOutputs,
    testConcurrentResumeTask,
    testConcurrentRestartFromTask,
    testSweepTaskTimeouts,
    testSweepTaskTimeoutExhaustion,
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

  console.log(`\n========== 并发测试结果: ${passed} 通过, ${failed} 失败 ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
