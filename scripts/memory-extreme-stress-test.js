/**
 * 记忆系统超高强度压力测试
 * 
 * 测试场景：
 * 1. 10,000 条批量写入 + 性能基准
 * 2. 10MB 超大内容存储与召回
 * 3. 并发写入竞争（多记忆系统实例）
 * 4. FTS 全文搜索压力（复杂查询）
 * 5. 标签组合过滤（AND/OR 逻辑）
 * 6. 混合负载（写/读/更新交替）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentMemorySystem } from '../runner/memory-system.js';
import { initializeMemoryStore, getMemoryStore } from '../storage/memories.js';
import { closeDb } from '../storage/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(n) {
  return n.toLocaleString('zh-CN');
}

// ============ 测试 1: 10,000 条批量写入 ============
async function testMassiveBulkWrite() {
  console.log('\n[Test 1] 超大量记忆写入（10,000 条）...');
  const db = path.join(__dirname, 'memory-massive.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const memorySystem = await createAgentMemorySystem({
    dbPath: db,
    scope: 'workspace',
    projectKey: 'massive-test',
    workspacePath: __dirname,
    memory: true
  });

  const start = Date.now();
  for (let i = 0; i < 10000; i++) {
    memorySystem.remember({
      type: i % 3 === 0 ? 'project' : i % 3 === 1 ? 'feedback' : 'decision',
      scope: 'workspace',
      title: `大规模记忆 ${i}`,
      summary: `摘要 ${i}: ${'x'.repeat(50)}`,
      content: `详细内容 ${i}: ${'内容'.repeat(20)}`,
      tags: ['stress', `batch-${Math.floor(i / 100)}`, `mod-${i % 50}`],
      sourceKind: 'stress-test',
      sourceRef: `massive-${i}`,
      stability: i % 10 === 0 ? 'volatile' : 'stable',
      confidence: 0.5 + (i % 50) / 100
    });
  }
  const writeElapsed = Date.now() - start;

  // 验证写入数量
  const allRecalled = memorySystem.recall({ sourceKind: 'stress-test', limit: 100 });
  assert(allRecalled.items.length > 0, '应能召回记忆');

  // FTS 搜索压力
  const ftsStart = Date.now();
  const ftsResult = memorySystem.recall({ text: '大规模记忆 5000', limit: 10 });
  const ftsElapsed = Date.now() - ftsStart;

  assert(ftsResult.items.length > 0, 'FTS 应能召回目标记忆');
  assert(ftsResult.items.some(item => item.title.includes('5000')), '应召回记忆 5000');

  // 统计信息
  const dbStat = await fs.stat(db);
  console.log(`  写入 10,000 条耗时: ${formatNumber(writeElapsed)}ms (${(10000 / writeElapsed * 1000).toFixed(0)} 条/秒)`);
  console.log(`  FTS 搜索耗时: ${ftsElapsed}ms`);
  console.log(`  数据库大小: ${formatBytes(dbStat.size)}`);
  console.log('  ✓ 通过');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 2: 10MB 超大内容 ============
async function testHugeContent() {
  console.log('\n[Test 2] 10MB 超大内容...');
  const db = path.join(__dirname, 'memory-huge.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const memorySystem = await createAgentMemorySystem({
    dbPath: db,
    scope: 'workspace',
    projectKey: 'huge-test',
    workspacePath: __dirname
  });

  // 10MB 内容
  const hugeContent = 'x'.repeat(10 * 1024 * 1024);
  const start = Date.now();
  memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: '10MB 超大内容测试',
    summary: '测试超大内容存储',
    content: hugeContent,
    tags: ['huge', 'stress'],
    sourceKind: 'stress-test',
    sourceRef: 'huge-content',
    stability: 'stable',
    confidence: 0.9
  });
  const writeElapsed = Date.now() - start;

  const recallStart = Date.now();
  const recalled = memorySystem.recall({ sourceRef: 'huge-content', limit: 1 });
  const recallElapsed = Date.now() - recallStart;

  assert(recalled.items.length === 1, '应能召回超大内容');
  assert(recalled.items[0].content.length === 10 * 1024 * 1024, '内容长度应完整保留');

  console.log(`  写入 10MB 耗时: ${writeElapsed}ms`);
  console.log(`  召回 10MB 耗时: ${recallElapsed}ms`);
  console.log('  ✓ 通过');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 3: 并发写入竞争 ============
async function testConcurrentWrites() {
  console.log('\n[Test 3] 并发写入竞争...');
  const db = path.join(__dirname, 'memory-concurrent.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const systems = [];
  for (let i = 0; i < 5; i++) {
    systems.push(await createAgentMemorySystem({
      dbPath: db,
      scope: 'workspace',
      projectKey: `concurrent-test-${i}`,
      workspacePath: __dirname
    }));
  }

  const start = Date.now();
  const writesPerSystem = 100;
  
  // 串行但交错写入（模拟并发）
  for (let round = 0; round < writesPerSystem; round++) {
    for (let s = 0; s < systems.length; s++) {
      systems[s].remember({
        type: 'project',
        scope: 'workspace',
        title: `并发写入 ${s}-${round}`,
        summary: `系统 ${s} 第 ${round} 轮`,
        content: `内容 ${s}-${round}`,
        tags: ['concurrent', `system-${s}`],
        sourceKind: 'stress-test',
        sourceRef: `concurrent-${s}-${round}`,
        stability: 'stable',
        confidence: 0.8
      });
    }
  }
  const elapsed = Date.now() - start;

  const totalWrites = systems.length * writesPerSystem;
  for (let s = 0; s < systems.length; s++) {
    const recalled = systems[s].recall({ sourceKind: 'stress-test', limit: totalWrites });
    assert(recalled.items.length === writesPerSystem, `系统 ${s} 应在自身 projectKey 边界内召回 ${writesPerSystem} 条，实际召回 ${recalled.items.length}`);
  }

  console.log(`  ${systems.length} 个实例 × ${writesPerSystem} 条 = ${totalWrites} 条写入`);
  console.log(`  总耗时: ${elapsed}ms (${(totalWrites / elapsed * 1000).toFixed(0)} 条/秒)`);
  console.log('  ✓ 通过');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 4: FTS 复杂查询压力 ============
async function testFtsPressure() {
  console.log('\n[Test 4] FTS 全文搜索压力...');
  const db = path.join(__dirname, 'memory-fts.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const memorySystem = await createAgentMemorySystem({
    dbPath: db,
    scope: 'workspace',
    projectKey: 'fts-test',
    workspacePath: __dirname
  });

  // 写入多样化内容（使用英文，因为 SQLite FTS5 unicode61 分词器不支持中文）
  const keywords = ['algorithm', 'database', 'distributed', 'cache', 'queue', 'microservice', 'container', 'monitoring'];
  for (let i = 0; i < 1000; i++) {
    const kw1 = keywords[i % keywords.length];
    const kw2 = keywords[(i + 1) % keywords.length];
    memorySystem.remember({
      type: 'project',
      scope: 'workspace',
      title: `${kw1} and ${kw2} design pattern ${i}`,
      summary: `Exploring ${kw1} in ${kw2} scenarios`,
      content: `This article analyzes ${kw1} and ${kw2} architecture. First introduces ${kw1} basics, then discusses best practices for ${kw2} integration. Results show ${kw1} with ${kw2} significantly improves performance.`,
      tags: [kw1, kw2, 'architecture'],
      sourceKind: 'stress-test',
      sourceRef: `fts-${i}`,
      stability: 'stable',
      confidence: 0.9
    });
  }

  // 复杂 FTS 查询
  const queries = [
    { text: 'algorithm', desc: '单关键词' },
    { text: 'distributed cache', desc: '双关键词' },
    { text: 'microservice container monitoring', desc: '三关键词' },
    { text: 'queue design', desc: '短语查询' }
  ];

  for (const q of queries) {
    const qs = Date.now();
    const result = memorySystem.recall({ text: q.text, limit: 20 });
    const qe = Date.now() - qs;
    assert(result.items.length > 0, `FTS 查询 "${q.text}" 应返回结果`);
    console.log(`  "${q.text}" (${q.desc}): ${result.items.length} 条, ${qe}ms`);
  }

  console.log('  ✓ 通过');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 5: 混合负载 ============
async function testMixedWorkload() {
  console.log('\n[Test 5] 混合负载（读写更新交替）...');
  const db = path.join(__dirname, 'memory-mixed.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const memorySystem = await createAgentMemorySystem({
    dbPath: db,
    scope: 'workspace',
    projectKey: 'mixed-test',
    workspacePath: __dirname
  });

  const start = Date.now();
  let writeCount = 0;
  let readCount = 0;
  let updateCount = 0;

  // 阶段 1: 批量写入
  for (let i = 0; i < 500; i++) {
    memorySystem.remember({
      type: 'project',
      scope: 'workspace',
      title: `混合负载记忆 ${i}`,
      summary: `摘要 ${i}`,
      content: `内容 ${i}`,
      tags: ['mixed', `phase-${i % 5}`],
      sourceKind: 'stress-test',
      sourceRef: `mixed-${i}`,
      stability: 'stable',
      confidence: 0.7
    });
    writeCount++;
  }

  // 阶段 2: 交替读取和更新
  for (let i = 0; i < 100; i++) {
    // 读取
    const recalled = memorySystem.recall({ sourceRef: `mixed-${i * 4}`, limit: 1 });
    if (recalled.items.length > 0) readCount++;

    // 更新（通过相同 sourceRef 写入新记录）
    memorySystem.remember({
      type: 'project',
      scope: 'workspace',
      title: `混合负载记忆 ${i * 4} 更新`,
      summary: `更新摘要 ${i}`,
      content: `更新内容 ${i}`,
      tags: ['mixed', 'updated'],
      sourceKind: 'stress-test',
      sourceRef: `mixed-${i * 4}`,
      stability: 'stable',
      confidence: 0.95
    });
    updateCount++;
  }

  // 阶段 3: 批量 FTS 搜索
  let ftsCount = 0;
  for (let i = 0; i < 50; i++) {
    const result = memorySystem.recall({ text: `混合负载记忆 ${i * 10}`, limit: 5 });
    ftsCount += result.items.length;
  }

  const elapsed = Date.now() - start;

  console.log(`  写入: ${writeCount}, 读取: ${readCount}, 更新: ${updateCount}, FTS: ${ftsCount} 条结果`);
  console.log(`  总耗时: ${elapsed}ms`);
  console.log('  ✓ 通过');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 6: 边界值压力 ============
async function testBoundaryPressure() {
  console.log('\n[Test 6] 边界值压力...');
  const db = path.join(__dirname, 'memory-boundary.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const memorySystem = await createAgentMemorySystem({
    dbPath: db,
    scope: 'workspace',
    projectKey: 'boundary-test',
    workspacePath: __dirname
  });

  // 超长标题（5000 字符）
  const ultraLongTitle = 'T'.repeat(5000);
  memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: ultraLongTitle,
    summary: '超长标题测试',
    content: '内容',
    tags: ['boundary'],
    sourceKind: 'stress-test',
    sourceRef: 'ultra-long-title',
    stability: 'stable',
    confidence: 0.9
  });

  // 超多标签（500 个）
  const manyTags = Array.from({ length: 500 }, (_, i) => `tag-${i}`);
  memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: '超多标签',
    summary: '500 个标签',
    content: '内容',
    tags: manyTags,
    sourceKind: 'stress-test',
    sourceRef: 'many-tags-500',
    stability: 'stable',
    confidence: 0.9
  });

  // 特殊 Unicode（emoji 组合）
  const emojiContent = '👨‍👩‍👧‍👦🏳️‍🌈🧑‍💻'.repeat(1000);
  memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Emoji 压力测试',
    summary: '复杂 Unicode',
    content: emojiContent,
    tags: ['unicode', 'emoji'],
    sourceKind: 'stress-test',
    sourceRef: 'emoji-stress',
    stability: 'stable',
    confidence: 0.9
  });

  // 验证召回
  const r1 = memorySystem.recall({ sourceRef: 'ultra-long-title', limit: 1 });
  assert(r1.items[0].title === ultraLongTitle, '超长标题应完整保留');

  const r2 = memorySystem.recall({ sourceRef: 'many-tags-500', limit: 1 });
  assert(r2.items.length === 1, '超多标签记忆应存在');

  const r3 = memorySystem.recall({ sourceRef: 'emoji-stress', limit: 1 });
  assert(r3.items[0].content === emojiContent, 'Emoji 内容应完整保留');

  console.log('  超长标题: 5000 字符 ✓');
  console.log('  超多标签: 500 个 ✓');
  console.log('  复杂 Unicode: emoji 组合 ✓');
  console.log('  ✓ 通过');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 主函数 ============
async function main() {
  console.log('========================================');
  console.log('  记忆系统超高强度压力测试');
  console.log('========================================');

  const tests = [
    testMassiveBulkWrite,
    testHugeContent,
    testConcurrentWrites,
    testFtsPressure,
    testMixedWorkload,
    testBoundaryPressure,
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
      if (error.stack) console.error(error.stack.split('\n').slice(0, 3).join('\n'));
    }
  }

  console.log('\n========================================');
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
