/**
 * 上下文污染压力测试 - 验证记忆系统的隔离边界
 * 
 * 测试场景：
 * 1. 跨 workflow 记忆泄漏
 * 2. 跨 scope 污染
 * 3. sourceRef 伪造攻击
 * 4. projectKey 隔离破坏
 * 5. session 残留
 * 6. workspacePath 越界
 * 7. 标签注入召回
 * 8. FTS 注入召回
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentContextSystem,
  createAgentMemorySystem,
  createWorkflowEngine,
  createWorkflowRunner
} from '../index.js';
import { initializeMemoryStore } from '../storage/memories.js';
import { initializeContextStore } from '../storage/contexts.js';
import { closeDb } from '../storage/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoLeak(actual, predicate, message) {
  const leaked = actual.filter(predicate);
  assert(leaked.length === 0, `${message}: 发现 ${leaked.length} 条泄漏记录`);
}

// ============ 测试 1: 跨 workflow 记忆泄漏 ============
async function testCrossWorkflowLeak() {
  console.log('\n[Test 1] 跨 workflow 记忆泄漏...');
  const db = path.join(__dirname, 'pollution-workflow.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const sysA = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'workflow-A', workspacePath: __dirname
  });
  const sysB = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'workflow-B', workspacePath: __dirname
  });

  // A 写入敏感记忆
  sysA.remember({
    type: 'project', scope: 'workspace', title: 'A 的密钥',
    summary: 'secret', content: 'A-SECRET-KEY-12345',
    tags: ['secret', 'workflow-a'], sourceKind: 'test', sourceRef: 'a-secret',
    stability: 'stable', confidence: 0.9
  });

  // B 尝试召回
  const bRecall = sysB.recall({ text: 'SECRET', limit: 10 });
  const leakedToB = bRecall.items.filter(i => i.content?.includes('A-SECRET'));

  console.log(`  B 默认召回 ${bRecall.items.length} 条，其中含 A 敏感内容: ${leakedToB.length} 条`);
  assert(leakedToB.length === 0, '默认 recall 不应跨 projectKey 泄漏 A 的记忆');

  const bFiltered = sysB.recall({ text: 'SECRET', projectKey: 'workflow-B', limit: 10 });
  const leakedFiltered = bFiltered.items.filter(i => i.content?.includes('A-SECRET'));
  assert(leakedFiltered.length === 0, '显式 projectKey 过滤应阻止泄漏');
  console.log('  ✓ 通过 - 默认/显式 projectKey 都阻止泄漏');

  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 2: 跨 scope 污染 ============
async function testCrossScopePollution() {
  console.log('\n[Test 2] 跨 scope 污染...');
  const db = path.join(__dirname, 'pollution-scope.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const sys = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'scope-test', workspacePath: __dirname
  });

  // 写入不同 scope 的记忆
  sys.remember({
    type: 'project', scope: 'workspace', title: 'Workspace 记忆',
    summary: 's', content: 'workspace-content',
    tags: ['scope-test'], sourceKind: 'test', sourceRef: 'scope-ws',
    stability: 'stable', confidence: 0.9
  });
  sys.remember({
    type: 'project', scope: 'session', title: 'Session 记忆',
    summary: 's', content: 'session-content',
    tags: ['scope-test'], sourceKind: 'test', sourceRef: 'scope-sess',
    stability: 'stable', confidence: 0.9
  });
  sys.remember({
    type: 'project', scope: 'global', title: 'Global 记忆',
    summary: 's', content: 'global-content',
    tags: ['scope-test'], sourceKind: 'test', sourceRef: 'scope-global',
    stability: 'stable', confidence: 0.9
  });

  // 按 scope 过滤召回
  const wsRecall = sys.recall({ scope: 'workspace', limit: 10 });
  const sessRecall = sys.recall({ scope: 'session', limit: 10 });
  const globalRecall = sys.recall({ scope: 'global', limit: 10 });

  assert(wsRecall.items.length === 1 && wsRecall.items[0].scope === 'workspace', 'workspace scope 应只召回 workspace');
  assert(sessRecall.items.length === 1 && sessRecall.items[0].scope === 'session', 'session scope 应只召回 session');
  assert(globalRecall.items.length === 1 && globalRecall.items[0].scope === 'global', 'global scope 应只召回 global');

  console.log('  ✓ 通过 - scope 隔离严格');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 3: sourceRef 伪造攻击 ============
async function testSourceRefForgery() {
  console.log('\n[Test 3] sourceRef 伪造攻击...');
  const db = path.join(__dirname, 'pollution-forgery.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const sys = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'forgery-test', workspacePath: __dirname
  });

  // 用户 A 写入
  sys.remember({
    type: 'project', scope: 'workspace', title: 'A 的文档',
    summary: 's', content: 'original-a',
    tags: ['doc'], sourceKind: 'user', sourceRef: 'user-a-doc-1',
    stability: 'stable', confidence: 0.9
  });

  // 攻击者 B 伪造相同的 sourceRef
  sys.remember({
    type: 'project', scope: 'workspace', title: '伪造文档',
    summary: 's', content: 'forged-by-b',
    tags: ['doc'], sourceKind: 'user', sourceRef: 'user-a-doc-1',
    stability: 'stable', confidence: 0.9
  });

  // 查询相同 sourceRef
  const recalled = sys.recall({ sourceRef: 'user-a-doc-1', limit: 10 });
  
  // createMemory 语义下，相同 sourceRef 产生多条记录（不会覆盖）
  assert(recalled.items.length === 2, `相同 sourceRef 应产生 2 条记录，实际 ${recalled.items.length}`);
  
  // 验证原始记录未被覆盖
  const original = recalled.items.find(i => i.content === 'original-a');
  assert(original, '原始记录应仍存在');

  console.log('  ✓ 通过 - sourceRef 伪造产生独立记录，原始数据未被覆盖');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 4: projectKey 隔离破坏 ============
async function testProjectKeyIsolation() {
  console.log('\n[Test 4] projectKey 隔离破坏...');
  const db = path.join(__dirname, 'pollution-project.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const sys = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'project-alpha', workspacePath: __dirname
  });

  // 写入 project-alpha 记忆
  sys.remember({
    type: 'project', scope: 'workspace', projectKey: 'project-alpha',
    title: 'Alpha 机密', summary: 's', content: 'alpha-secret-data',
    tags: ['confidential'], sourceKind: 'test', sourceRef: 'alpha-1',
    stability: 'stable', confidence: 0.9
  });

  // 同一系统，不同 projectKey 查询
  const alphaRecall = sys.recall({ projectKey: 'project-alpha', limit: 10 });
  const betaRecall = sys.recall({ projectKey: 'project-beta', limit: 10 });

  assert(alphaRecall.items.length === 1, 'project-alpha 应召回 1 条');
  assert(betaRecall.items.length === 0, 'project-beta 应召回 0 条（隔离）');

  console.log('  ✓ 通过 - projectKey 隔离严格');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 5: session 残留 ============
async function testSessionResidue() {
  console.log('\n[Test 5] session 残留...');
  const db = path.join(__dirname, 'pollution-session.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const sys = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'session-test', workspacePath: __dirname
  });

  // 写入 session 记忆
  sys.remember({
    type: 'feedback', scope: 'session', title: '临时会话',
    summary: 's', content: 'session-temp-data',
    tags: ['temp'], sourceKind: 'test', sourceRef: 'sess-1',
    stability: 'volatile', confidence: 0.5
  });

  // 写入 workspace 记忆
  sys.remember({
    type: 'project', scope: 'workspace', title: '永久记忆',
    summary: 's', content: 'workspace-perm-data',
    tags: ['perm'], sourceKind: 'test', sourceRef: 'ws-1',
    stability: 'stable', confidence: 0.9
  });

  const allRecall = sys.recall({ limit: 10 });
  const sessionInAll = allRecall.items.filter(i => i.scope === 'session');

  console.log(`  默认召回: ${allRecall.items.length} 条，含 session: ${sessionInAll.length}`);
  assert(sessionInAll.length === 0, '默认 recall 不应混入 session 记忆');

  const wsOnly = sys.recall({ scope: 'workspace', limit: 10 });
  assert(wsOnly.items.every(i => i.scope === 'workspace'), 'workspace scope 应排除 session');
  console.log('  ✓ 通过 - 默认/显式 scope 都阻止 session 泄漏');

  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 6: workspacePath 越界 ============
async function testWorkspacePathEscape() {
  console.log('\n[Test 6] workspacePath 越界...');
  const db = path.join(__dirname, 'pollution-path.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const sysA = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'path-test', workspacePath: '/project/A'
  });
  const sysB = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'path-test', workspacePath: '/project/B'
  });

  // A 在 /project/A 写入
  sysA.remember({
    type: 'project', scope: 'workspace', title: 'A 的文件',
    summary: 's', content: 'file-in-a',
    tags: ['file'], sourceKind: 'test', sourceRef: 'file-a',
    stability: 'stable', confidence: 0.9
  });

  const bRecall = sysB.recall({ limit: 10 });
  const leaked = bRecall.items.filter(i => i.content === 'file-in-a');
  console.log(`  B 默认召回 ${bRecall.items.length} 条，含 A 内容: ${leaked.length}`);
  assert(leaked.length === 0, '默认 recall 不应跨 workspacePath 泄漏 A 的内容');

  const bFiltered = sysB.recall({ workspacePath: '/project/B', limit: 10 });
  assert(bFiltered.items.length === 0, 'B 的 workspacePath 应看不到 A 的内容');
  console.log('  ✓ 通过 - 默认/显式 workspacePath 都阻止泄漏');

  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 7: 标签注入召回 ============
async function testTagInjection() {
  console.log('\n[Test 7] 标签注入召回...');
  const db = path.join(__dirname, 'pollution-tag.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const sys = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'tag-test', workspacePath: __dirname
  });

  // 写入带标签的记忆
  sys.remember({
    type: 'project', scope: 'workspace', title: '机密文档',
    summary: 's', content: 'top-secret',
    tags: ['confidential', 'restricted'], sourceKind: 'test', sourceRef: 'conf-1',
    stability: 'stable', confidence: 0.9
  });

  // 攻击者尝试用标签召回
  const tagRecall = sys.recall({ tags: ['confidential'], limit: 10 });
  console.log(`  标签 'confidential' 召回: ${tagRecall.items.length} 条`);

  // 标签召回是否受 scope/projectKey 限制？
  // 当前实现：tags 过滤是额外的 AND 条件，但基础查询仍受其他参数限制
  assert(tagRecall.items.length >= 1, '标签召回应正常工作');

  // 跨 scope 标签注入
  const sysOther = await createAgentMemorySystem({
    dbPath: db, scope: 'session', projectKey: 'tag-test', workspacePath: __dirname
  });
  sysOther.remember({
    type: 'project', scope: 'session', title: '会话标签',
    summary: 's', content: 'session-data',
    tags: ['confidential'], sourceKind: 'test', sourceRef: 'sess-conf',
    stability: 'stable', confidence: 0.9
  });

  // workspace scope 查询不应召回 session scope 的同名标签
  const wsTagRecall = sys.recall({ tags: ['confidential'], scope: 'workspace', limit: 10 });
  assert(wsTagRecall.items.every(i => i.scope === 'workspace'), 'workspace + 标签应排除 session');
  console.log('  ✓ 通过 - 标签召回受 scope 限制');

  closeDb(db);
  await fs.rm(db, { force: true });
}

async function testContextBoundaryIsolation() {
  console.log('\n[Test 9] context 边界隔离...');
  const db = path.join(__dirname, 'pollution-context.db');
  await fs.rm(db, { force: true });
  await initializeContextStore({ dbPath: db });

  const ctxA = await createAgentContextSystem({
    dbPath: db, scope: 'workspace', projectKey: 'ctx-A', workspacePath: '/ctx/A', sessionId: 'session-A'
  });
  const ctxB = await createAgentContextSystem({
    dbPath: db, scope: 'workspace', projectKey: 'ctx-B', workspacePath: '/ctx/B', sessionId: 'session-B'
  });

  const itemA = ctxA.writeItem({
    kind: 'note', title: 'A item', summary: 's', content: 'context-a-secret'
  }).item;
  const snapshotA = ctxA.writeSnapshot({
    title: 'A snapshot', summary: 's', content: 'snapshot-a-secret', items: [{ contextId: itemA.contextId }]
  }).snapshot;

  const itemsForB = ctxB.queryItems({ limit: 10 });
  assertNoLeak(itemsForB.items, (item) => item.content === 'context-a-secret', '默认 queryItems 不应跨边界泄漏');

  const snapshotsForB = ctxB.querySnapshots({ limit: 10 });
  assertNoLeak(snapshotsForB.items, (snapshot) => snapshot.content === 'snapshot-a-secret', '默认 querySnapshots 不应跨边界泄漏');

  const itemState = ctxB.getItemState({ contextId: itemA.contextId });
  assert(itemState.item?.content === 'context-a-secret', 'targeted getItemState 应保留可用');

  const snapshotState = ctxB.getSnapshotState({ snapshotId: snapshotA.snapshotId });
  assert(snapshotState.snapshot?.content === 'snapshot-a-secret', 'targeted getSnapshotState 应保留可用');

  console.log('  ✓ 通过 - broad retrieval 被隔离，targeted lookup 保持可用');
  closeDb(db);
  await fs.rm(db, { force: true });
}

// ============ 测试 8: FTS 注入召回 ============
async function testFtsInjection() {
  console.log('\n[Test 8] FTS 注入召回...');
  const db = path.join(__dirname, 'pollution-fts.db');
  await fs.rm(db, { force: true });
  await initializeMemoryStore({ dbPath: db });

  const sys = await createAgentMemorySystem({
    dbPath: db, scope: 'workspace', projectKey: 'fts-test', workspacePath: __dirname
  });

  // 写入敏感和公开记忆
  sys.remember({
    type: 'project', scope: 'workspace', title: 'Secret Plan',
    summary: 's', content: 'classified information about project X',
    tags: ['secret'], sourceKind: 'test', sourceRef: 'fts-secret',
    stability: 'stable', confidence: 0.9
  });
  sys.remember({
    type: 'project', scope: 'workspace', title: 'Public Info',
    summary: 's', content: 'publicly available information',
    tags: ['public'], sourceKind: 'test', sourceRef: 'fts-public',
    stability: 'stable', confidence: 0.9
  });

  sys.remember({
    type: 'project', scope: 'workspace', title: 'Unrelated Note',
    summary: 's', content: 'totally unrelated archive material',
    tags: ['misc'], sourceKind: 'test', sourceRef: 'fts-unrelated',
    stability: 'stable', confidence: 0.9
  });

  // 正常 FTS 查询
  const normal = sys.recall({ text: 'public', limit: 10 });
  assert(normal.items.length === 1, '正常查询应召回 1 条');

  // FTS 注入尝试：混入操作符和特殊字符扩大搜索
  const injection = sys.recall({ text: 'public" OR classified --', limit: 10 });
  console.log(`  注入查询 'public" OR classified --' 召回: ${injection.items.length} 条`);

  const hasClassified = injection.items.some(i => i.content?.includes('classified'));
  const hasPublic = injection.items.some(i => i.content?.includes('public'));
  const hasUnrelated = injection.items.some(i => i.content?.includes('totally unrelated'));

  // buildFtsMatchQuery 会提取字母数字词元，再用 OR 连接；
  // 注入字符本身不会原样进入 MATCH 语句，也不应扩大到无关记录。
  assert(hasClassified, '注入查询应仍可匹配 extracted token: classified');
  assert(hasPublic, '注入查询应仍可匹配 extracted token: public');
  assert(!hasUnrelated, '注入查询不应召回无关记录');
  console.log(`  含 'classified': ${hasClassified}, 含 'public': ${hasPublic}, 含无关记录: ${hasUnrelated}`);
  console.log('  ✓ 通过 - FTS 注入字符未突破词元化边界');

  closeDb(db);
  await fs.rm(db, { force: true });
}


async function testWorkflowHygienePredecessorOutputs() {
  console.log('\n[Test 10] workflow 上游输出 hygiene 隔离...');
  const db = path.join(__dirname, 'pollution-hygiene-outputs.db');
  await fs.rm(db, { force: true });

  const engine = await createWorkflowEngine({ dbPath: db });
  const memorySystem = await createAgentMemorySystem({ dbPath: db });
  const contextSystem = await createAgentContextSystem({ dbPath: db });
  const workspacePath = 'C:/workspace/workflow-closure';
  const created = await createHygieneWorkflow(engine, {
    workflowId: 'hygiene-output-workflow',
    steps: [
      { key: 'producer', title: '生成上游产物', status: 'ready' },
      { key: 'consumer', title: '消费上游产物', description: '使用 HYGIENE-CONTENT 完成任务' }
    ],
    dependencies: [{ from: 'producer', to: 'consumer' }]
  });
  const producer = findTask(created, 'producer');
  const consumer = findTask(created, 'consumer');

  completeReadyTask(engine, created.workflow.workflowId, producer.taskId, {
    doneSummary: '生产者已输出多种信任状态。',
    taskOutputs: [
      {
        kind: 'artifact', name: 'validated-doc', content: 'VALIDATED-HYGIENE-CONTENT',
        metadata: { trustState: 'validated' }
      },
      {
        kind: 'artifact', name: 'tainted-doc', content: 'TAINTED-HYGIENE-CONTENT',
        metadata: { trustState: 'tainted' }
      },
      {
        kind: 'artifact', name: 'superseded-doc', content: 'SUPERSEDED-HYGIENE-CONTENT',
        metadata: { trustState: 'superseded' }
      }
    ]
  });

  const runner = await createWorkflowRunner({
    dbPath: db,
    engine,
    workflowId: created.workflow.workflowId,
    taskId: consumer.taskId,
    memory: createHygieneMemoryOptions(memorySystem, workspacePath, 'hygiene-output-session'),
    context: createHygieneContextOptions(contextSystem, workspacePath, 'hygiene-output-session'),
    runnerId: 'hygiene-output-runner',
    adapter: ({ prompt, contextSnapshot, contextItems }) => ({
      status: 'done',
      doneSummary: '消费者完成。',
      payload: {
        prompt,
        contextSnapshot,
        contextItems
      }
    })
  });

  const result = await runner.runOnce();

  assert(result.status === 'done', 'consumer 应完成');
  assert(result.prompt.includes('VALIDATED-HYGIENE-CONTENT'), 'prompt 应包含 validated 上游输出');
  assert(!result.prompt.includes('TAINTED-HYGIENE-CONTENT'), 'prompt 不应包含 tainted 上游输出');
  assert(!result.prompt.includes('SUPERSEDED-HYGIENE-CONTENT'), 'prompt 不应包含 superseded 上游输出');
  assert(result.contextItems.some((item) => item.kind === 'predecessor-output' && item.hygieneLabel === 'validated'), 'context item 应标注 validated predecessor output');
  assert(result.contextItems.every((item) => !String(item.content || '').includes('TAINTED-HYGIENE-CONTENT')), 'context bundle 不应包含 tainted 输出');
  assert(result.contextSnapshot?.metadata?.hygieneSummary?.byLabel?.validated >= 1, 'context snapshot 应记录 hygiene summary');
  assert(result.contextItems.some((item) => item.metadata?.hygiene?.provenance?.outputId), 'context item 应记录输出 provenance');

  console.log('  ✓ 通过 - 仅 validated 上游输出进入 prompt/context，snapshot 保留 hygiene 元数据');
  closeDb(db);
  await fs.rm(db, { force: true });
}

async function testWorkflowHygieneRepairEvidence() {
  console.log('\n[Test 11] failed 验证输出仅进入 repair task...');
  const db = path.join(__dirname, 'pollution-hygiene-repair.db');
  await fs.rm(db, { force: true });

  const engine = await createWorkflowEngine({ dbPath: db });
  const contextSystem = await createAgentContextSystem({ dbPath: db });
  const workspacePath = 'C:/workspace/workflow-closure';
  const created = await createHygieneWorkflow(engine, {
    workflowId: 'hygiene-repair-workflow',
    steps: [
      { key: 'producer', title: '执行验证', status: 'ready' },
      { key: 'repair-validation-failure', title: '修复验证失败', contract: { repairOf: 'validation-result' } }
    ],
    dependencies: [
      {
        from: 'producer',
        to: 'repair-validation-failure',
        condition: {
          outputKind: 'validation-result',
          outputName: 'validation-commands',
          path: 'metadata.trustState',
          operator: 'equals',
          value: 'failed'
        }
      }
    ]
  });
  const producer = findTask(created, 'producer');
  const repairTask = findTask(created, 'repair-validation-failure');

  completeReadyTask(engine, created.workflow.workflowId, producer.taskId, {
    status: 'blocked',
    blockedReason: '验证失败。',
    taskOutputs: [
      {
        kind: 'validation-result', name: 'validation-commands', content: 'FAILED-VALIDATION-HYGIENE-CONTENT',
        metadata: { trustState: 'failed', passed: false, command: 'npm test' }
      }
    ]
  });

  const runner = await createWorkflowRunner({
    dbPath: db,
    engine,
    workflowId: created.workflow.workflowId,
    taskId: repairTask.taskId,
    context: createHygieneContextOptions(contextSystem, workspacePath, 'hygiene-repair-session'),
    runnerId: 'hygiene-repair-runner',
    adapter: ({ prompt, contextItems }) => ({
      status: 'done',
      doneSummary: '修复任务完成。',
      payload: { prompt, contextItems }
    })
  });

  const result = await runner.runOnce();

  assert(result.status === 'done', 'repair task 应完成');
  assert(result.prompt.includes('FAILED-VALIDATION-HYGIENE-CONTENT'), 'repair task prompt 应包含 failed 验证证据');
  assert(result.contextItems.some((item) => item.hygieneLabel === 'recovery-only' && item.sourceClass === 'failed-validation-evidence'), 'failed 验证证据应标注 recovery-only');
  assert(result.contextSnapshot?.metadata?.hygieneSummary?.byLabel?.['recovery-only'] >= 1, 'snapshot 应记录 recovery-only 摘要');

  console.log('  ✓ 通过 - failed validation evidence 只进入 repair 任务并标注 recovery-only');
  closeDb(db);
  await fs.rm(db, { force: true });
}

async function testWorkflowGeneratedMemoryGate() {
  console.log('\n[Test 12] workflow-generated lifecycle memory 保守写入...');
  const db = path.join(__dirname, 'pollution-hygiene-memory.db');
  await fs.rm(db, { force: true });

  const engine = await createWorkflowEngine({ dbPath: db });
  const memorySystem = await createAgentMemorySystem({ dbPath: db });
  const workspacePath = 'C:/workspace/workflow-closure';
  const created = await createHygieneWorkflow(engine, {
    workflowId: 'hygiene-memory-workflow',
    steps: [
      { key: 'done-task', title: '写入生命周期记忆', status: 'ready' }
    ],
    dependencies: []
  });
  const task = findTask(created, 'done-task');

  const runner = await createWorkflowRunner({
    dbPath: db,
    engine,
    workflowId: created.workflow.workflowId,
    taskId: task.taskId,
    memory: createHygieneMemoryOptions(memorySystem, workspacePath, 'hygiene-memory-session'),
    runnerId: 'hygiene-memory-runner',
    adapter: () => ({ status: 'done', doneSummary: '生命周期任务完成。' })
  });

  const result = await runner.runOnce();
  assert(result.status === 'done', 'task 应完成');

  const recalled = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'hygiene-test',
    workspacePath,
    sessionId: 'hygiene-memory-session',
    sourceKind: 'workflow-task',
    sourceRef: `workflow:${created.workflow.workflowId}:task:${task.taskId}`,
    limit: 5
  });
  const memory = recalled.items[0];
  assert(memory, '应写入 workflow task lifecycle memory');
  assert(memory.type === 'feedback', '非 promotable lifecycle memory 应写为 feedback');
  assert(memory.stability === 'volatile', '非 promotable lifecycle memory 应保持 volatile');

  const state = memorySystem.getMemoryState({ memoryId: memory.memoryId });
  const tags = state.tags.map((tag) => tag.tag);
  assert(tags.includes('workflow-generated'), 'lifecycle memory 应带 workflow-generated 标签');
  assert(tags.includes('requires-promotion'), 'lifecycle memory 应带 requires-promotion 标签');
  assert(tags.includes('lifecycle'), 'lifecycle memory 应带 lifecycle source class 标签');

  console.log('  ✓ 通过 - 自动 lifecycle memory 默认 volatile/reference-like，不提升为 stable project memory');
  closeDb(db);
  await fs.rm(db, { force: true });
}

async function testReferenceMemoryPromptLabel() {
  console.log('\n[Test 13] reference memory prompt 标注...');
  const db = path.join(__dirname, 'pollution-hygiene-reference-memory.db');
  await fs.rm(db, { force: true });

  const engine = await createWorkflowEngine({ dbPath: db });
  const memorySystem = await createAgentMemorySystem({ dbPath: db });
  const workspacePath = 'C:/workspace/workflow-closure';
  const created = await createHygieneWorkflow(engine, {
    workflowId: 'hygiene-reference-memory-workflow',
    goal: 'REFERENCE-MEMORY-HYGIENE-TOKEN',
    instruction: '需要使用 REFERENCE-MEMORY-HYGIENE-TOKEN 相关历史参考。',
    steps: [
      { key: 'consumer', title: '使用 REFERENCE-MEMORY-HYGIENE-TOKEN 参考记忆', status: 'ready' }
    ],
    dependencies: []
  });
  const task = findTask(created, 'consumer');

  memorySystem.remember({
    type: 'project', scope: 'workspace', projectKey: 'hygiene-test', workspacePath, sessionId: 'hygiene-reference-session',
    title: 'REFERENCE-MEMORY-HYGIENE-TOKEN 历史参考', summary: 'reference summary', content: 'REFERENCE-MEMORY-HYGIENE-CONTENT',
    tags: ['reference-memory'], sourceKind: 'manual-note', sourceRef: 'reference-memory-note', stability: 'stable', confidence: 0.9
  });

  const runner = await createWorkflowRunner({
    dbPath: db,
    engine,
    workflowId: created.workflow.workflowId,
    taskId: task.taskId,
    memory: createHygieneMemoryOptions(memorySystem, workspacePath, 'hygiene-reference-session'),
    runnerId: 'hygiene-reference-runner',
    adapter: ({ prompt, recalledMemories }) => ({
      status: 'done',
      doneSummary: '引用参考记忆完成。',
      payload: { prompt, recalledMemories }
    })
  });

  const result = await runner.runOnce();

  assert(result.status === 'done', 'reference memory consumer 应完成');
  assert(result.prompt.includes('REFERENCE-MEMORY-HYGIENE-CONTENT'), 'prompt 应包含参考记忆内容');
  assert(result.prompt.includes('hygiene=reference'), 'prompt 应标注 reference hygiene');
  assert(result.prompt.includes('use=historical-reference'), 'prompt 应标注 historical-reference 用途');
  assert(result.recalledMemories.some((item) => item.hygieneLabel === 'reference' && item.allowedUse === 'historical-reference'), 'recalled memory 应带 reference classification');

  console.log('  ✓ 通过 - reference memory 进入 prompt 时带历史参考标注');
  closeDb(db);
  await fs.rm(db, { force: true });
}

async function createHygieneWorkflow(engine, input) {
  return engine.createWorkflowFromTaskSource({
    workflowId: input.workflowId,
    taskSource: {
      async load() {
        return {
          workflowId: input.workflowId,
          goal: input.goal || 'hygiene pollution test',
          instruction: input.instruction || 'run hygiene pollution test',
          plan: {
            goal: input.goal || 'hygiene pollution test',
            steps: input.steps,
            dependencies: input.dependencies
          },
          concurrencyLimit: 3,
          metadata: { taskSource: 'context-pollution-hygiene-test' }
        };
      }
    }
  });
}

function findTask(state, planTaskKey) {
  const task = state.tasks.find((item) => item.planTaskKey === planTaskKey);
  assert(task, `应找到任务 ${planTaskKey}`);
  return task;
}

function completeReadyTask(engine, workflowId, taskId, input = {}) {
  engine.advanceTaskStatus({ workflowId, taskId, status: 'doing' });
  return engine.advanceTaskStatus({
    workflowId,
    taskId,
    status: input.status || 'done',
    doneSummary: input.doneSummary,
    blockedReason: input.blockedReason,
    taskOutputs: input.taskOutputs || []
  });
}

function createHygieneMemoryOptions(system, workspacePath, sessionId) {
  return {
    system,
    scope: 'workspace',
    projectKey: 'hygiene-test',
    workspacePath,
    sessionId,
    limit: 8
  };
}

function createHygieneContextOptions(system, workspacePath, sessionId) {
  return {
    system,
    scope: 'workspace',
    projectKey: 'hygiene-test',
    workspacePath,
    sessionId,
    limit: 8
  };
}

// ============ 主函数 ============
async function main() {
  console.log('========================================');
  console.log('  上下文污染压力测试');
  console.log('========================================');

  const tests = [
    testCrossWorkflowLeak,
    testCrossScopePollution,
    testSourceRefForgery,
    testProjectKeyIsolation,
    testSessionResidue,
    testWorkspacePathEscape,
    testTagInjection,
    testContextBoundaryIsolation,
    testFtsInjection,
    testWorkflowHygienePredecessorOutputs,
    testWorkflowHygieneRepairEvidence,
    testWorkflowGeneratedMemoryGate,
    testReferenceMemoryPromptLabel,
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
