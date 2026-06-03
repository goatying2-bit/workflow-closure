/**
 * 偷懒行为压力测试 - 验证系统对"偷懒"Agent的防御能力
 * 
 * "偷懒"指 Agent 试图：
 * 1. 空跑 - 不执行就标记 done
 * 2. 伪造结果 - 返回虚假完成摘要
 * 3. 跳过任务 - 直接 claim 后面的任务
 * 4. 不释放 lease - 占着任务不执行
 * 5. 重复 claim 已完成的任务
 * 6. 忽略阻塞原因 - resume 后不处理错误
 * 7. 伪造 heartbeat - 假装还在执行
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

// ============ 测试 1: 空跑 - 直接 complete 不执行 ============
async function testEmptyComplete() {
  console.log('\n[Test 1] 空跑防御 - 直接 complete...');
  const db = path.join(__dirname, 'laziness-empty.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '空跑测试',
    plan: {
      goal: '空跑',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  const wfId = created.data.workflow.workflowId;

  // 不 claim 直接 complete（应该失败）
  const fakeComplete = await runCli('complete-task', {
    dbPath: db,
    workflowId: wfId,
    taskId: created.data.task.taskId,
    doneSummary: '假装完成'
  });
  // 系统应该拒绝（任务不是 doing 状态）
  assert(!fakeComplete.success, '未 claim 就 complete 应该失败');

  // 正常 claim 后 complete
  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 60000
  });
  assert(claim.success, 'claim 失败');

  const complete = await runCli('complete-task', {
    dbPath: db,
    workflowId: wfId,
    taskId: claim.data.task.taskId,
    doneSummary: '真正完成',
    leaseOwner: 'runner'
  });
  assert(complete.success, '正常 complete 应该成功');
  assert(complete.data.task.status === 'done', '应标记为 done');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过 - 系统拒绝未 claim 的 complete');
}

// ============ 测试 2: 伪造 heartbeat - 错误 owner ============
async function testFakeHeartbeat() {
  console.log('\n[Test 2] 伪造 heartbeat 防御...');
  const db = path.join(__dirname, 'laziness-heartbeat.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: 'heartbeat 测试',
    plan: {
      goal: 'hb',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'real-runner', leaseMs: 60000
  });
  assert(claim.success, 'claim 失败');

  // 伪造 heartbeat - 错误的 owner
  const fakeHb = await runCli('heartbeat-task-lease', {
    dbPath: db,
    workflowId: claim.data.task.workflowId,
    taskId: claim.data.task.taskId,
    leaseOwner: 'fake-runner',
    leaseMs: 120000
  });
  assert(!fakeHb.success, '错误 owner 的 heartbeat 应该失败');

  // 正确的 owner
  const realHb = await runCli('heartbeat-task-lease', {
    dbPath: db,
    workflowId: claim.data.task.workflowId,
    taskId: claim.data.task.taskId,
    leaseOwner: 'real-runner',
    leaseMs: 120000
  });
  assert(realHb.success, '正确 owner 的 heartbeat 应该成功');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过 - 系统拒绝伪造 heartbeat');
}

// ============ 测试 3: 占着 lease 不释放 ============
async function testLeaseHogging() {
  console.log('\n[Test 3] lease 占用防御 - 过期后强制释放...');
  const db = path.join(__dirname, 'laziness-hog.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: 'lease 占用测试',
    plan: {
      goal: 'hog',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  // 占用 lease 但很短
  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'hogger', leaseMs: 100
  });
  assert(claim.success, 'claim 失败');

  // 等待过期
  await new Promise(r => setTimeout(r, 300));

  // 另一个 runner 应该能 claim（lease 已过期）
  const claim2 = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'new-runner', leaseMs: 60000
  });
  assert(claim2.success && claim2.data.status === 'claimed', 
    'lease 过期后其他 runner 应能 claim');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过 - lease 过期后自动释放');
}

// ============ 测试 4: 重复 claim 已完成的任务 ============
async function testReclaimDone() {
  console.log('\n[Test 4] 重复 claim done 任务防御...');
  const db = path.join(__dirname, 'laziness-reclaim.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '重复 claim 测试',
    plan: {
      goal: 'reclaim',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  const wfId = created.data.workflow.workflowId;

  // 正常完成
  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 60000
  });
  await runCli('complete-task', {
    dbPath: db, workflowId: wfId,
    taskId: claim.data.task.taskId, doneSummary: '完成',
    leaseOwner: 'runner'
  });

  // 尝试再次 claim（应该 idle）
  const reclaim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 60000
  });
  assert(reclaim.success && reclaim.data.status === 'idle', 
    '已完成的任务不应被再次 claim');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过 - done 任务不能被重复 claim');
}

// ============ 测试 5: 跳过阻塞原因直接 resume ============
async function testIgnoreBlockReason() {
  console.log('\n[Test 5] 忽略阻塞原因防御...');
  const db = path.join(__dirname, 'laziness-ignore.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '忽略阻塞测试',
    plan: {
      goal: 'ignore',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  const wfId = created.data.workflow.workflowId;

  // claim 并 block
  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 60000
  });
  const taskId = claim.data.task.taskId;

  await runCli('block-task', {
    dbPath: db, workflowId: wfId, taskId,
    blockedReason: '需要人工审核代码',
    leaseOwner: 'runner'
  });

  // resume（系统允许，但会保留 lastError）
  const resume = await runCli('resume-task', {
    dbPath: db, workflowId: wfId, taskId
  });
  assert(resume.success, 'resume 应成功');
  assert(resume.data.task.status === 'ready', '应回到 ready');
  assert(resume.data.task.lastError === '需要人工审核代码', 
    'lastError 应保留阻塞原因，提示 Agent 需要处理');

  // 再次 claim 时 prompt 应包含错误提示
  const claim2 = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 60000
  });
  assert(claim2.data.prompt.includes('最近错误'), 
    'prompt 应提示之前的错误，防止 Agent 忽略');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过 - resume 后保留错误提示');
}

// ============ 测试 6: 伪造任务完成摘要 ============
async function testFakeSummary() {
  console.log('\n[Test 6] 伪造完成摘要检测...');
  const db = path.join(__dirname, 'laziness-fake.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '伪造摘要测试',
    plan: {
      goal: 'fake',
      steps: [{ key: 's1', title: '实现登录功能', type: 'implement' }],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  const wfId = created.data.workflow.workflowId;

  // claim
  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 60000
  });

  // 提交空的 doneSummary（系统允许，但会记录）
  const complete = await runCli('complete-task', {
    dbPath: db, workflowId: wfId,
    taskId: claim.data.task.taskId,
    doneSummary: '',  // 空的完成摘要
    leaseOwner: 'runner'
  });
  assert(complete.success, 'complete 应成功');
  assert(complete.data.task.doneSummary === null || complete.data.task.doneSummary === '', 
    '空摘要应被记录');

  // runLog 应记录这次完成
  const state = await runCli('get-workflow-state', { dbPath: db, workflowId: wfId });
  const completeLog = state.data.runLogs.find(l => l.action === 'task_completed_via_cli');
  assert(completeLog, '应有完成日志记录');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过 - 空摘要被记录，可审计');
}

// ============ 测试 7: 尝试修改其他 workflow 的任务 ============
async function testCrossWorkflowTamper() {
  console.log('\n[Test 7] 跨 workflow 篡改防御...');
  const db = path.join(__dirname, 'laziness-cross.db');
  await fs.rm(db, { force: true });

  // 创建两个工作流
  const w1 = await runCli('create-workflow', {
    dbPath: db,
    instruction: '工作流1',
    plan: { goal: 'w1', steps: [{ key: 's1', title: '任务1', type: 'implement' }], dependencies: [] }
  });
  const w2 = await runCli('create-workflow', {
    dbPath: db,
    instruction: '工作流2',
    plan: { goal: 'w2', steps: [{ key: 's1', title: '任务2', type: 'implement' }], dependencies: [] }
  });

  // claim w1 的任务
  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'runner', leaseMs: 60000
  });
  const w1TaskId = claim.data.task.taskId;

  // 尝试用 w2 的 ID 完成 w1 的任务
  const tamper = await runCli('complete-task', {
    dbPath: db,
    workflowId: w2.data.workflow.workflowId,  // 错误的 workflowId
    taskId: w1TaskId,
    doneSummary: '篡改',
    leaseOwner: 'runner'
  });
  assert(!tamper.success, '跨 workflow 篡改应失败');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过 - 跨 workflow 操作被拒绝');
}

async function testFakeBlock() {
  console.log('\n[Test 8] 伪造 block 防御...');
  const db = path.join(__dirname, 'laziness-block.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: 'block 测试',
    plan: {
      goal: 'block',
      steps: [{ key: 's1', title: '任务', type: 'implement' }],
      dependencies: []
    }
  });
  assert(created.success, '创建失败');

  const claim = await runCli('claim-next-ready-task', {
    dbPath: db, leaseOwner: 'real-runner', leaseMs: 60000
  });
  assert(claim.success, 'claim 失败');

  const fakeBlock = await runCli('block-task', {
    dbPath: db,
    workflowId: claim.data.task.workflowId,
    taskId: claim.data.task.taskId,
    blockedReason: '伪造阻塞',
    leaseOwner: 'fake-runner'
  });
  assert(!fakeBlock.success, '错误 owner 的 block-task 应该失败');

  const realBlock = await runCli('block-task', {
    dbPath: db,
    workflowId: claim.data.task.workflowId,
    taskId: claim.data.task.taskId,
    blockedReason: '真实阻塞',
    leaseOwner: 'real-runner'
  });
  assert(realBlock.success, '正确 owner 的 block-task 应该成功');
  assert(realBlock.data.task.status === 'blocked', '任务应进入 blocked');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过 - 系统拒绝伪造 block-task');
}

// ============ 主函数 ============
async function main() {
  const tests = [
    testEmptyComplete,
    testFakeHeartbeat,
    testLeaseHogging,
    testReclaimDone,
    testIgnoreBlockReason,
    testFakeSummary,
    testCrossWorkflowTamper,
    testFakeBlock,
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

  console.log(`\n========== 偷懒行为压力测试: ${passed} 通过, ${failed} 失败 ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
