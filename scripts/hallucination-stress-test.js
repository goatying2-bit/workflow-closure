/**
 * 幻觉压力测试 - 验证系统在长时间/大量操作后是否保持状态一致性
 * 
 * "幻觉"指：
 * 1. 任务状态与实际不符（如标记 done 但未真正完成）
 * 2. 重复 claim 同一任务
 * 3. 丢失任务（ready 任务消失）
 * 4. 错误的依赖解析（未完成的依赖任务被跳过）
 * 5. 内存/上下文泄漏导致的不一致
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);
const cliPath = path.join(rootDir, 'cli.js');

async function runCli(command, input = {}) {
  const args = [cliPath, command, '--input', JSON.stringify(input)];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => {
      resolve({ 
        success: code === 0, 
        stdout, 
        stderr,
        data: code === 0 ? JSON.parse(stdout) : null
      });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ============ 测试 1: 反复 block/resume 后状态一致性 ============
async function testBlockResumeConsistency() {
  console.log('\n[Test 1] 反复 block/resume 10 次后状态一致性...');
  const db = path.join(__dirname, 'hallucination-block.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: 'block/resume 一致性测试',
    plan: {
      goal: '一致性',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  const wfId = created.data.workflow.workflowId;
  let taskId = null;

  // 反复 block/resume 10 次
  for (let i = 0; i < 10; i++) {
    const claim = await runCli('claim-next-ready-task', {
      dbPath: db, leaseOwner: 'runner', leaseMs: 60000
    });
    assert(claim.success && claim.data.status === 'claimed', `第 ${i+1} 次 claim 失败`);
    taskId = claim.data.task.taskId;

    const block = await runCli('block-task', {
      dbPath: db, workflowId: wfId, taskId,
      blockedReason: `第 ${i+1} 次阻塞`,
      leaseOwner: 'runner'
    });
    assert(block.success, `第 ${i+1} 次 block 失败`);
    assert(block.data.task.status === 'blocked', `第 ${i+1} 次 block 后状态应为 blocked`);

    const resume = await runCli('resume-task', {
      dbPath: db, workflowId: wfId, taskId
    });
    assert(resume.success, `第 ${i+1} 次 resume 失败`);
    assert(resume.data.task.status === 'ready', `第 ${i+1} 次 resume 后状态应为 ready`);
  }

  // 最终验证
  const state = await runCli('get-workflow-state', { dbPath: db, workflowId: wfId });
  const task = state.data.tasks.find(t => t.taskId === taskId);
  assert(task.status === 'ready', `最终状态应为 ready，实际是 ${task.status}`);
  assert(task.lastError === '第 10 次阻塞', `lastError 应保留最后一次阻塞原因`);
  assert(task.attemptCount === 10, `attemptCount 应为 10，实际是 ${task.attemptCount}`);

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 2: 大量任务中随机 claim/complete 后无丢失 ============
async function testNoTaskLoss() {
  console.log('\n[Test 2] 20 个任务随机 claim/complete 后无丢失...');
  const db = path.join(__dirname, 'hallucination-loss.db');
  await fs.rm(db, { force: true });

  const steps = [];
  const deps = [];
  for (let i = 0; i < 20; i++) {
    steps.push({ key: `s${i}`, title: `任务${i}`, type: 'implement' });
    if (i > 0) deps.push({ from: `s${i-1}`, to: `s${i}` });
  }

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '无丢失测试',
    plan: { goal: '无丢失', steps, dependencies: deps }
  });
  assert(created.success, '创建失败');

  const wfId = created.data.workflow.workflowId;

  // 顺序完成所有任务
  for (let i = 0; i < 20; i++) {
    const claim = await runCli('claim-next-ready-task', {
      dbPath: db, leaseOwner: 'runner', leaseMs: 60000
    });
    assert(claim.success && claim.data.status === 'claimed', `第 ${i+1} 个任务 claim 失败`);

    const complete = await runCli('complete-task', {
      dbPath: db,
      workflowId: claim.data.task.workflowId,
      taskId: claim.data.task.taskId,
      doneSummary: `完成 ${claim.data.task.title}`,
      leaseOwner: 'runner'
    });
    assert(complete.success, `第 ${i+1} 个任务 complete 失败`);
  }

  // 验证所有任务都是 done
  const state = await runCli('get-workflow-state', { dbPath: db, workflowId: wfId });
  const doneCount = state.data.tasks.filter(t => t.status === 'done').length;
  assert(doneCount === 20, `应有 20 个 done 任务，实际 ${doneCount}`);
  assert(state.data.workflow.status === 'done', '工作流应完成');

  // 再次 claim 应返回 idle
  const finalClaim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 60000
  });
  assert(finalClaim.success && finalClaim.data.status === 'idle', '所有任务完成后应返回 idle');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 3: 并发 claim 不会重复分配同一任务 ============
async function testNoDoubleClaim() {
  console.log('\n[Test 3] 并发 claim 不会重复分配...');
  const db = path.join(__dirname, 'hallucination-double.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '重复分配测试',
    plan: {
      goal: '重复分配',
      steps: [
        { key: 's1', title: '任务1', type: 'implement' },
        { key: 's2', title: '任务2', type: 'implement' }
      ],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  // 10 个进程同时 claim
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(runCli('claim-next-ready-task', {
      dbPath: db, leaseOwner: `runner-${i}`, leaseMs: 60000
    }));
  }

  const results = await Promise.all(promises);
  const claimed = results.filter(r => r.success && r.data?.status === 'claimed');
  
  // 收集被 claim 的任务 ID
  const claimedTaskIds = claimed.map(r => r.data.task.taskId);
  const uniqueTaskIds = [...new Set(claimedTaskIds)];
  
  assert(claimedTaskIds.length === uniqueTaskIds.length, 
    `发现重复分配！claimed ${claimedTaskIds.length} 次，但只涉及 ${uniqueTaskIds.length} 个唯一任务`);

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 4: restart-from-task 后依赖关系正确 ============
async function testRestartDependencyIntegrity() {
  console.log('\n[Test 4] restart-from-task 后依赖关系正确...');
  const db = path.join(__dirname, 'hallucination-restart.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: 'restart 依赖测试',
    plan: {
      goal: 'restart',
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
  assert(created.success, '创建失败');

  const wfId = created.data.workflow.workflowId;

  // 完成任务1
  let claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'r1', leaseMs: 60000 });
  await runCli('complete-task', { dbPath: db, workflowId: wfId, taskId: claim.data.task.taskId, doneSummary: '完成1', leaseOwner: 'r1' });

  // 完成任务2
  claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'r1', leaseMs: 60000 });
  const task2Id = claim.data.task.taskId;
  await runCli('complete-task', { dbPath: db, workflowId: wfId, taskId: task2Id, doneSummary: '完成2', leaseOwner: 'r1' });

  // 从任务2 restart
  const restart = await runCli('restart-from-task', {
    dbPath: db, workflowId: wfId, taskId: task2Id,
    reason: '测试 restart', fingerprint: 'fp1', maxSameFingerprintReruns: 5
  });
  assert(restart.success, 'restart 失败');

  // 验证：任务1保持 done，任务2回到 ready，任务3回到 pending
  const state = await runCli('get-workflow-state', { dbPath: db, workflowId: wfId });
  const tasks = state.data.tasks;
  
  const task1 = tasks.find(t => t.taskId !== task2Id && t.status === 'done');
  assert(task1, '任务1应保持 done');
  
  const task2 = tasks.find(t => t.taskId === task2Id);
  assert(task2.status === 'ready', `任务2应回到 ready，实际是 ${task2.status}`);
  
  const task3 = tasks.find(t => t.status === 'pending');
  assert(task3, '任务3应回到 pending');

  // 验证不能跳过任务2直接 claim 任务3
  claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'r1', leaseMs: 60000 });
  assert(claim.data.task.taskId === task2Id, '应先 claim 到任务2，不能跳过');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 5: lease 过期后任务正确释放 ============
async function testLeaseExpiration() {
  console.log('\n[Test 5] lease 过期后任务正确释放...');
  const db = path.join(__dirname, 'hallucination-lease.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: 'lease 过期测试',
    plan: {
      goal: 'lease',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  // claim 但设置很短的 lease
  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 100
  });
  assert(claim.success, 'claim 失败');

  // 等待 lease 过期
  await new Promise(r => setTimeout(r, 300));

  // 释放过期 lease
  const release = await runCli('release-expired-leases', {
    dbPath: db, reason: '测试释放'
  });
  assert(release.success, 'release 失败');
  assert(release.data.releasedTaskCount >= 1, '应释放至少 1 个任务');

  // 验证任务回到 ready
  const state = await runCli('get-workflow-state', {
    dbPath: db, workflowId: claim.data.task.workflowId
  });
  const task = state.data.tasks.find(t => t.taskId === claim.data.task.taskId);
  assert(task.status === 'ready', `lease 过期后任务应回到 ready，实际是 ${task.status}`);
  assert(task.leaseOwner === null, 'leaseOwner 应为 null');

  // 可以再次 claim
  const claim2 = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner2', leaseMs: 60000
  });
  assert(claim2.success && claim2.data.status === 'claimed', '应能再次 claim');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 主函数 ============
async function main() {
  const tests = [
    testBlockResumeConsistency,
    testNoTaskLoss,
    testNoDoubleClaim,
    testRestartDependencyIntegrity,
    testLeaseExpiration,
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

  console.log(`\n========== 幻觉压力测试: ${passed} 通过, ${failed} 失败 ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
