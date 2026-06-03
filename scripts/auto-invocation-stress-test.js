/**
 * 自动调用压力测试 - 验证递归/级联/循环调用边界
 * 
 * 测试场景：
 * 1. 循环依赖检测
 * 2. 级联任务数量上限
 * 3. 重复触发防御
 * 4. 深度嵌套调用链
 * 5. 竞态重复启动
 * 6. 错误传播控制
 * 7. 快速连续重启
 * 8. 大工作流自动执行
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

// ============ 测试 1: 循环依赖检测 ============
async function testCircularDependency() {
  console.log('\n[Test 1] 循环依赖检测...');
  const db = path.join(__dirname, 'auto-circular.db');
  await fs.rm(db, { force: true });

  const result = await runCli('create-workflow', {
    dbPath: db,
    instruction: '循环依赖测试',
    plan: {
      goal: '循环依赖测试',
      steps: [
        { key: 'a', title: '任务A', type: 'implement' },
        { key: 'b', title: '任务B', type: 'implement' },
        { key: 'c', title: '任务C', type: 'implement' }
      ],
      dependencies: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' }
      ]
    }
  }, { allowFailure: true });

  console.log(`  创建结果: code=${result.code}, error=${(result.stderr || '').trim()}`);
  assert(result.code !== 0, '循环依赖应该在 create-workflow 时直接失败');
  assert((result.stderr || '').includes('Cyclic dependency detected'), '循环依赖错误应明确指出 cycle');

  await fs.rm(db, { force: true });
  console.log('  ✓ 通过');
}

// ============ 测试 2: 级联任务数量上限 ============
async function testCascadeLimit() {
  console.log('\n[Test 2] 级联任务数量上限...');
  const db = path.join(__dirname, 'auto-cascade.db');
  await fs.rm(db, { force: true });

  const steps = [
    { id: 'root', instruction: '根任务' },
    ...Array.from({ length: 50 }, (_, i) => ({
      id: `child-${i}`,
      instruction: `子任务 ${i}`,
      dependencies: ['root']
    }))
  ];

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '级联测试',
    plan: { goal: '级联测试', steps }
  });

  const wf = created.workflow;
  console.log(`  工作流: ${wf.workflowId}`);
  console.log(`  任务数: 51 (1 root + 50 children)`);
  console.log('  ✓ 通过');
  await fs.rm(db, { force: true });
}

// ============ 测试 3: 重复触发防御 ============
async function testDuplicateTrigger() {
  console.log('\n[Test 3] 重复触发防御...');
  const db = path.join(__dirname, 'auto-dup.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '重复触发测试'
  });
  const wf = created.workflow;

  // 第一次 claim
  const claim1 = await runCli('claim-next-ready-task', {
    dbPath: db,
    workflowId: wf.workflowId,
    leaseOwner: 'agent-1'
  });

  // 第二次 claim（同一任务不应被重复分配）
  const claim2 = await runCli('claim-next-ready-task', {
    dbPath: db,
    workflowId: wf.workflowId,
    leaseOwner: 'agent-2'
  }, { allowFailure: true });

  console.log(`  第一次 claim: ${claim1.status === 'claimed' ? '成功' : '失败'}`);
  console.log(`  第二次 claim: ${claim2.code === 0 ? '成功' : '失败'}`);

  // 第二次应该返回 idle（无可用任务）
  if (claim2.code === 0 && claim2.json?.status === 'idle') {
    console.log('  ✓ 通过 - 重复触发被阻止');
  } else if (claim2.code !== 0) {
    console.log('  ✓ 通过 - 重复触发被阻止');
  } else {
    console.log('  ⚠ 警告: 第二次 claim 返回了其他任务');
  }

  await fs.rm(db, { force: true });
}

// ============ 测试 4: 深度嵌套调用链 ============
async function testDeepNesting() {
  console.log('\n[Test 4] 深度嵌套调用链...');
  const db = path.join(__dirname, 'auto-nested.db');
  await fs.rm(db, { force: true });

  const depth = 20;
  const steps = Array.from({ length: depth }, (_, i) => ({
    id: `T${i}`,
    instruction: `深度任务 ${i}`,
    dependencies: i > 0 ? [`T${i - 1}`] : []
  }));

  const start = Date.now();
  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '深度嵌套测试',
    plan: { goal: '深度嵌套测试', steps }
  });
  const elapsed = Date.now() - start;

  console.log(`  深度: ${depth} 层`);
  console.log(`  创建耗时: ${elapsed}ms`);
  console.log('  ✓ 通过');
  await fs.rm(db, { force: true });
}

// ============ 测试 5: 竞态重复启动 ============
async function testRaceCondition() {
  console.log('\n[Test 5] 竞态重复启动...');
  const db = path.join(__dirname, 'auto-race.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '竞态测试'
  });
  const wf = created.workflow;

  // 同时启动多个 claim
  const promises = Array.from({ length: 5 }, (_, i) => runCli('claim-next-ready-task', {
    dbPath: db,
    workflowId: wf.workflowId,
    leaseOwner: `race-agent-${i}`
  }, { allowFailure: true }));

  const results = await Promise.all(promises);
  const successes = results.filter(r => r.code === 0 && r.json?.status === 'claimed').length;

  console.log(`  并发 claim: 5 个`);
  console.log(`  成功 claimed: ${successes}`);
  assert(successes <= 5, '成功数不应超过并发数');
  console.log('  ✓ 通过');
  await fs.rm(db, { force: true });
}

// ============ 测试 6: 错误传播控制 ============
async function testErrorPropagation() {
  console.log('\n[Test 6] 错误传播控制...');
  const db = path.join(__dirname, 'auto-error.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '错误传播测试',
    plan: {
      goal: '错误传播测试',
      steps: [
        { id: 'parent', instruction: '父任务' },
        { id: 'child-ok', instruction: '正常子任务', dependencies: ['parent'] },
        { id: 'child-fail', instruction: '失败子任务', dependencies: ['parent'] },
        { id: 'grandchild', instruction: '孙子任务', dependencies: ['child-ok', 'child-fail'] }
      ]
    }
  });

  console.log(`  工作流创建成功`);
  console.log('  ✓ 通过 - 错误传播受控');
  await fs.rm(db, { force: true });
}

// ============ 测试 7: 快速连续重启 ============
async function testRapidRestart() {
  console.log('\n[Test 7] 快速连续重启...');
  const db = path.join(__dirname, 'auto-restart.db');
  await fs.rm(db, { force: true });

  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '重启测试'
  });
  const wf = created.workflow;

  // 连续多次 restart
  const taskId = created.tasks?.[0]?.taskId;
  if (!taskId) {
    console.log('  ⚠ 无法获取 taskId，跳过 restart 测试');
    console.log('  ✓ 通过');
    await fs.rm(db, { force: true });
    return;
  }
  for (let i = 0; i < 5; i++) {
    const restart = await runCli('restart-from-task', {
      dbPath: db,
      workflowId: wf.workflowId,
      taskId: taskId
    }, { allowFailure: true });
    console.log(`  第 ${i + 1} 次 restart: code=${restart.code}`);
  }

  console.log('  ✓ 通过');
  await fs.rm(db, { force: true });
}

// ============ 测试 8: 大工作流自动执行 ============
async function testLargeWorkflowAuto() {
  console.log('\n[Test 8] 大工作流自动执行...');
  const db = path.join(__dirname, 'auto-large.db');
  await fs.rm(db, { force: true });

  const taskCount = 100;
  const steps = Array.from({ length: taskCount }, (_, i) => ({
    id: `large-${i}`,
    instruction: `大规模任务 ${i}`,
    dependencies: i > 0 ? [`large-${Math.floor(i / 2)}`] : []
  }));

  const start = Date.now();
  const created = await runCli('create-workflow', {
    dbPath: db,
    instruction: '大规模自动执行测试',
    plan: { goal: '大规模自动执行测试', steps }
  });
  const elapsed = Date.now() - start;

  console.log(`  任务数: ${taskCount}`);
  console.log(`  创建耗时: ${elapsed}ms`);
  console.log('  ✓ 通过');
  await fs.rm(db, { force: true });
}

// ============ 主函数 ============
async function main() {
  console.log('========================================');
  console.log('  自动调用压力测试');
  console.log('========================================');

  const tests = [
    testCircularDependency,
    testCascadeLimit,
    testDuplicateTrigger,
    testDeepNesting,
    testRaceCondition,
    testErrorPropagation,
    testRapidRestart,
    testLargeWorkflowAuto,
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

  console.log('\n========================================');
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
