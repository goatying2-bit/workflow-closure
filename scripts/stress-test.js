/**
 * 压力测试与边界测试
 * 模拟各种异常场景和边界条件
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const cliPath = path.join(rootDir, 'cli.js');

async function runCli(command, input = {}, options = {}) {
  const args = [cliPath, command, '--input', JSON.stringify(input)];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

  if (!options.allowFailure && result.code !== 0) {
    throw new Error(`CLI command failed: ${command}\n${result.stderr || result.stdout}`);
  }

  if (options.allowFailure) {
    if (result.stdout.trim()) return { ...result, json: JSON.parse(result.stdout) };
    return result;
  }

  return JSON.parse(result.stdout);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// ============ 测试 1: lease 过期后重复释放 ============
async function testDoubleLeaseRelease() {
  console.log('\n[Test 1] lease 过期后重复释放...');
  const db = path.join(__dirname, 'stress-test-lease.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: 'lease 测试',
    plan: { goal: 'lease 测试', steps: [{ key: 'step-1', title: 'lease 任务', type: 'implement' }], dependencies: [] }
  });

  const claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'runner', leaseMs: 5 });
  assert(claim.status === 'claimed', '应该 claim 成功');

  await new Promise(r => setTimeout(r, 50));

  const release1 = await runCli('release-expired-leases', { dbPath: db, reason: '第一次释放' });
  const release2 = await runCli('release-expired-leases', { dbPath: db, reason: '第二次释放' });

  console.log(`  第一次释放: ${release1.releasedTaskCount} 个任务`);
  console.log(`  第二次释放: ${release2.releasedTaskCount} 个任务`);

  assert(release1.releasedTaskCount >= 1, '第一次应该释放任务');
  assert(release2.releasedTaskCount === 0, '第二次不应该释放任务');

  const state = await runCli('get-workflow-state', { dbPath: db, workflowId: created.workflow.workflowId });
  assert(state.tasks[0].status === 'ready', '任务应该回到 ready');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 2: 空 plan / 无效 plan ============
async function testInvalidPlan() {
  console.log('\n[Test 2] 空 plan / 无效 plan...');
  const db = path.join(__dirname, 'stress-test-plan.db');
  await fs.rm(db, { force: true });

  const emptyPlan = await runCli('create-workflow', {
    dbPath: db,
    instruction: '空 plan 测试',
    plan: {}
  }, { allowFailure: true });
  console.log(`  空 plan: code=${emptyPlan.code}, error=${(emptyPlan.stderr || '').substring(0, 100)}`);
  assert(emptyPlan.code !== 0, '空 plan 应该失败');

  const noSteps = await runCli('create-workflow', {
    dbPath: db,
    instruction: '无 steps 测试',
    plan: { goal: '无 steps', steps: [], dependencies: [] }
  }, { allowFailure: true });
  console.log(`  无 steps: code=${noSteps.code ?? 0}`);
  assert(noSteps.code !== 0, '无 steps 应该失败');

  const cyclic = await runCli('create-workflow', {
    dbPath: db,
    instruction: '循环依赖测试',
    plan: {
      goal: '循环依赖',
      steps: [
        { key: 'a', title: 'A', type: 'implement' },
        { key: 'b', title: 'B', type: 'implement' }
      ],
      dependencies: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' }
      ]
    }
  }, { allowFailure: true });
  console.log(`  循环依赖: code=${cyclic.code}, error=${(cyclic.stderr || '').trim()}`);
  assert(cyclic.code !== 0, '循环依赖应该在 create-workflow 时直接失败');
  assert((cyclic.stderr || '').includes('Cyclic dependency detected'), '循环依赖错误应明确指出 cycle');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 3: 大量任务工作流 ============
async function testLargeWorkflow() {
  console.log('\n[Test 3] 大量任务工作流...');
  const db = path.join(__dirname, 'stress-test-large.db');
  await fs.rm(db, { force: true });

  const steps = [];
  const dependencies = [];
  for (let i = 0; i < 50; i++) {
    steps.push({ key: `step-${i}`, title: `任务 ${i}`, type: 'implement' });
    if (i > 0) {
      dependencies.push({ from: `step-${i-1}`, to: `step-${i}` });
    }
  }

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '大量任务测试',
    plan: { goal: '大量任务', steps, dependencies }
  });

  console.log(`  创建: ${created.summary?.taskCount} 个任务`);
  assert(created.summary?.taskCount === 50, `应该有 50 个任务，实际 ${created.summary?.taskCount}`);

  let completed = 0;
  while (true) {
    const claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'runner', leaseMs: 60000 });
    if (claim.status === 'idle') break;
    await runCli('complete-task', {
      dbPath: db,
      workflowId: claim.task.workflowId,
      taskId: claim.task.taskId,
      doneSummary: `完成: ${claim.task.title}`,
      leaseOwner: 'runner'
    });
    completed++;
  }

  console.log(`  完成: ${completed} 个任务`);
  assert(completed === 50, `应该完成 50 个任务，实际 ${completed}`);

  const state = await runCli('get-workflow-state', { dbPath: db, workflowId: created.workflow.workflowId });
  assert(state.workflow.status === 'done', '工作流应该完成');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 4: coordinator 同一任务多次 assign ============
async function testCoordinatorDoubleAssign() {
  console.log('\n[Test 4] coordinator 同一任务多次 assign...');
  const db = path.join(__dirname, 'stress-test-coord.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: 'coordinator 竞态测试',
    plan: { goal: 'coordinator 竞态', steps: [{ key: 'step-1', title: '竞态任务', type: 'implement' }], dependencies: [] }
  });

  await runCli('register-agent', {
    dbPath: db,
    agentId: 'agent-1',
    name: 'Agent 1',
    role: 'implementer',
    adapterModule: path.join(__dirname, 'cli-coordinator-smoke-adapter.js'),
    status: 'active',
    maxConcurrency: 10
  });

  const assign1 = await runCli('assign-next-work', {
    dbPath: db,
    workflowId: created.workflow.workflowId,
    targetType: 'task',
    taskId: created.task.taskId
  });
  console.log(`  第一次 assign: ${assign1.status}`);
  assert(assign1.status === 'assigned', '第一次应该 assign 成功');

  const assign2 = await runCli('assign-next-work', {
    dbPath: db,
    workflowId: created.workflow.workflowId,
    targetType: 'task',
    taskId: created.task.taskId
  });
  console.log(`  第二次 assign: ${assign2.status}`);
  assert(assign2.status === 'assigned', '第二次应返回已有 active assignment');
  assert(assign2.assignment?.assignmentId === assign1.assignment?.assignmentId, '第二次不应创建新的 active assignment');
  assert(assign2.agent?.agentId === assign1.agent?.agentId, '第二次应返回同一个已分配 agent');

  const coordState = await runCli('get-coordinator-state', {
    dbPath: db,
    workflowId: created.workflow.workflowId,
    assignmentLimit: 20
  });
  console.log(`  assignment 数量: ${coordState.assignments?.length}`);
  assert(coordState.assignments?.length === 1, '同一 target 只应保留一条 active assignment');
  assert(coordState.assignments?.[0]?.status === 'assigned', '唯一 assignment 应保持 assigned');

  const wfState = await runCli('get-workflow-state', { dbPath: db, workflowId: created.workflow.workflowId });
  console.log(`  任务状态: ${wfState.tasks[0].status}`);
  assert(wfState.tasks[0].assignmentStatus === 'assigned', '任务 assignmentStatus 应保持 assigned');
  assert(wfState.tasks[0].ownerAgentId === 'agent-1', '任务 owner 应保持第一次分配的 agent');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 5: 特殊字符和注入测试 ============
async function testSpecialCharacters() {
  console.log('\n[Test 5] 特殊字符和注入测试...');
  const db = path.join(__dirname, 'stress-test-chars.db');
  await fs.rm(db, { force: true });

  const injection = await runCli('create-workflow', {
    dbPath: db,
    instruction: "'; DROP TABLE workflows; --"
  });
  console.log(`  SQL 注入: status=${injection.status}`);

  const state = await runCli('get-workflow-state', { dbPath: db, workflowId: injection.workflow.workflowId });
  assert(state.workflow.instruction === "'; DROP TABLE workflows; --", '特殊字符应该被保留');

  const longInstruction = 'A'.repeat(10000);
  const long = await runCli('create-workflow', {
    dbPath: db,
    instruction: longInstruction
  });
  console.log(`  超长指令 (${longInstruction.length} 字符): status=${long.status}`);

  const unicode = await runCli('create-workflow', {
    dbPath: db,
    instruction: '🚀 测试 \u0000 \n \t \\ "\' 中文 العربية'
  });
  console.log(`  Unicode: status=${unicode.status}`);

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 6: heartbeat 错误 owner ============
async function testHeartbeatWrongOwner() {
  console.log('\n[Test 6] heartbeat 错误 owner...');
  const db = path.join(__dirname, 'stress-test-hb.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: 'heartbeat 测试',
    plan: { goal: 'heartbeat', steps: [{ key: 'step-1', title: 'hb 任务', type: 'implement' }], dependencies: [] }
  });

  const claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'runner', leaseMs: 5000 });
  assert(claim.status === 'claimed');

  // 正确的 owner
  const correctHb = await runCli('heartbeat-task-lease', {
    dbPath: db,
    workflowId: claim.task.workflowId,
    taskId: claim.task.taskId,
    leaseOwner: 'runner',
    leaseMs: 10000
  });
  console.log(`  正确 owner: status=${correctHb.status}`);

  // 错误的 owner
  const wrongOwner = await runCli('heartbeat-task-lease', {
    dbPath: db,
    workflowId: claim.task.workflowId,
    taskId: claim.task.taskId,
    leaseOwner: 'wrong-owner',
    leaseMs: 10000
  }, { allowFailure: true });
  console.log(`  错误 owner: code=${wrongOwner.code}`);
  assert(wrongOwner.code !== 0, '错误 owner 应该失败');

  // 不存在的 task
  const noTask = await runCli('heartbeat-task-lease', {
    dbPath: db,
    workflowId: claim.task.workflowId,
    taskId: 'non-existent-task-id',
    leaseOwner: 'runner',
    leaseMs: 10000
  }, { allowFailure: true });
  console.log(`  不存在 task: code=${noTask.code}`);
  assert(noTask.code !== 0, '不存在 task 应该失败');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 7: chain 阶段边界 ============
async function testChainEdgeCases() {
  console.log('\n[Test 7] chain 阶段边界...');
  const db = path.join(__dirname, 'stress-test-chain.db');
  await fs.rm(db, { force: true });

  const single = await runCli('create-chain', {
    dbPath: db,
    adapterModule: path.join(__dirname, 'cli-chain-smoke-adapter.js'),
    instruction: '单阶段',
    stages: [{ title: '唯一阶段', instruction: '只有一个阶段' }]
  });
  console.log(`  单阶段: status=${single.chain?.status}`);

  const runSingle = await runCli('run-chain', {
    dbPath: db,
    adapterModule: path.join(__dirname, 'cli-chain-smoke-adapter.js'),
    chainId: single.chain.chainId,
    maxStages: 10
  });
  assert(runSingle.status === 'done', '单阶段应该完成');

  const emptyStages = await runCli('create-chain', {
    dbPath: db,
    adapterModule: path.join(__dirname, 'cli-chain-smoke-adapter.js'),
    instruction: '空阶段',
    stages: []
  }, { allowFailure: true });
  console.log(`  空 stages: code=${emptyStages.code ?? 0}`);
  assert(emptyStages.code !== 0, '空 stages 应该失败');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 8: 快速连续 claim/complete ============
async function testRapidClaimComplete() {
  console.log('\n[Test 8] 快速连续 claim/complete...');
  const db = path.join(__dirname, 'stress-test-rapid.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '快速测试',
    plan: {
      goal: '快速',
      steps: [
        { key: 's1', title: '任务1', type: 'implement' },
        { key: 's2', title: '任务2', type: 'implement' },
        { key: 's3', title: '任务3', type: 'implement' }
      ],
      dependencies: []
    }
  });

  // 快速连续 claim 和 complete
  for (let i = 0; i < 3; i++) {
    const claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'runner', leaseMs: 60000 });
    assert(claim.status === 'claimed', `第 ${i+1} 次 claim 应该成功`);
    await runCli('complete-task', {
      dbPath: db,
      workflowId: claim.task.workflowId,
      taskId: claim.task.taskId,
      doneSummary: `快速完成 ${i+1}`,
      leaseOwner: 'runner'
    });
  }

  const state = await runCli('get-workflow-state', { dbPath: db, workflowId: created.workflow.workflowId });
  assert(state.workflow.status === 'done', '工作流应该完成');
  assert(state.tasks.every(t => t.status === 'done'), '所有任务应该完成');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 9: 重复 restart-from-task ============
async function testRepeatedRestart() {
  console.log('\n[Test 9] 重复 restart-from-task...');
  const db = path.join(__dirname, 'stress-test-restart.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '重跑测试',
    plan: {
      goal: '重跑',
      steps: [
        { key: 's1', title: '任务1', type: 'implement' },
        { key: 's2', title: '任务2', type: 'implement' }
      ],
      dependencies: [{ from: 's1', to: 's2' }]
    }
  });

  // 完成任务
  let claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'runner', leaseMs: 60000 });
  await runCli('complete-task', { dbPath: db, workflowId: claim.task.workflowId, taskId: claim.task.taskId, doneSummary: '完成1', leaseOwner: 'runner' });
  claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'runner', leaseMs: 60000 });
  await runCli('complete-task', { dbPath: db, workflowId: claim.task.workflowId, taskId: claim.task.taskId, doneSummary: '完成2', leaseOwner: 'runner' });

  const state1 = await runCli('get-workflow-state', { dbPath: db, workflowId: created.workflow.workflowId });
  assert(state1.workflow.status === 'done', '应该完成');

  // 第一次 restart
  const restart1 = await runCli('restart-from-task', {
    dbPath: db,
    workflowId: created.workflow.workflowId,
    taskId: state1.tasks[0].taskId,
    reason: '第一次重跑',
    fingerprint: 'test-fp',
    maxSameFingerprintReruns: 5
  });
  console.log(`  第一次 restart: status=${restart1.status}`);

  // 再次完成
  claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'runner', leaseMs: 60000 });
  await runCli('complete-task', { dbPath: db, workflowId: claim.task.workflowId, taskId: claim.task.taskId, doneSummary: '完成1-2', leaseOwner: 'runner' });
  claim = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'runner', leaseMs: 60000 });
  await runCli('complete-task', { dbPath: db, workflowId: claim.task.workflowId, taskId: claim.task.taskId, doneSummary: '完成2-2', leaseOwner: 'runner' });

  // 第二次 restart（相同 fingerprint）
  const restart2 = await runCli('restart-from-task', {
    dbPath: db,
    workflowId: created.workflow.workflowId,
    taskId: state1.tasks[0].taskId,
    reason: '第二次重跑',
    fingerprint: 'test-fp',
    maxSameFingerprintReruns: 5
  });
  console.log(`  第二次 restart: status=${restart2.status}`);

  // 检查 rerun 列表
  const reruns = await runCli('list-workflow-reruns', { dbPath: db, workflowId: created.workflow.workflowId });
  console.log(`  rerun 数量: ${reruns.reruns?.length}`);
  assert(reruns.reruns?.length === 2, '应该有 2 次 rerun');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 10: 跨 workflow 的 taskId 冲突 ============
async function testCrossWorkflowTaskId() {
  console.log('\n[Test 10] 跨 workflow task 操作...');
  const db = path.join(__dirname, 'stress-test-cross.db');
  await fs.rm(db, { force: true });

  const w1 = await runCli('create-workflow', {
    dbPath: db,
    instruction: '工作流1',
    plan: { goal: 'w1', steps: [{ key: 's1', title: '任务', type: 'implement' }], dependencies: [] }
  });

  const w2 = await runCli('create-workflow', {
    dbPath: db,
    instruction: '工作流2',
    plan: { goal: 'w2', steps: [{ key: 's1', title: '任务', type: 'implement' }], dependencies: [] }
  });

  // claim w1 的任务
  const claim1 = await runCli('claim-next-ready-task', { dbPath: db, leaseOwner: 'runner', leaseMs: 60000 });
  console.log(`  claim1: workflowId=${claim1.task?.workflowId}`);

  // 尝试用 w2 的 workflowId 操作 w1 的 task
  const wrongWf = await runCli('complete-task', {
    dbPath: db,
    workflowId: w2.workflow.workflowId,  // 错误的 workflowId
    taskId: claim1.task.taskId,
    doneSummary: '完成',
    leaseOwner: 'runner'
  }, { allowFailure: true });
  console.log(`  错误 workflowId: code=${wrongWf.code}`);
  assert(wrongWf.code !== 0, '错误 workflowId 应该失败');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 主函数 ============
async function main() {
  const tests = [
    testDoubleLeaseRelease,
    testInvalidPlan,
    testLargeWorkflow,
    testCoordinatorDoubleAssign,
    testSpecialCharacters,
    testHeartbeatWrongOwner,
    testChainEdgeCases,
    testRapidClaimComplete,
    testRepeatedRestart,
    testCrossWorkflowTaskId,
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

  console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
  closeDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
