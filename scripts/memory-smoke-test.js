import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentMemorySystem
} from '../index.js';
import { upsertMemoryBySource } from '../runner/memory-system.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'memory-smoke-test.db');

function createSemanticTestEmbedder(options = {}) {
  return {
    embed(text, context = {}) {
      if (options.fail === true) {
        throw new Error('semantic embedder failed');
      }

      const normalizedText = String(text || '').toLowerCase();

      if (context.kind === 'query') {
        if (normalizedText.includes('alpha beta')) {
          return [1, 0];
        }

        if (normalizedText.trim() === 'beta') {
          return [0, 1];
        }

        return [0, 0];
      }

      if (normalizedText.includes('alpha concept note')) {
        return [1, 0];
      }

      if (normalizedText.includes('beta concept note')) {
        return [0, 1];
      }

      return [0, 0];
    }
  };
}

async function main() {
  await fs.rm(dbPath, { force: true });

  const memorySystem = await createAgentMemorySystem({ dbPath });

  const first = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'SQLite-first MVP',
    summary: 'Memory architecture direction',
    content: 'Super memory MVP should stay SQLite-first with hybrid recall and avoid a standalone vector database in the first version.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['architecture', 'mvp'],
    confidence: 0.95,
    stability: 'stable',
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:first'
  });

  const second = memorySystem.remember({
    type: 'feedback',
    scope: 'workspace',
    title: 'Structured recall preference',
    summary: 'Prefer metadata filters before text search',
    content: 'Recall should filter by scope, project, status, and tags before using text search so the result set stays auditable.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['retrieval', 'auditing'],
    confidence: 0.9,
    stability: 'stable',
    links: [
      {
        targetMemoryId: first.memory.memoryId,
        relation: 'supports'
      }
    ],
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:second'
  });

  const third = memorySystem.remember({
    type: 'reference',
    scope: 'session',
    title: 'Embedding extension note',
    summary: 'MCP can be a future provider',
    content: 'MCP can later provide embeddings or reranking, but it should not become the source of truth for memory storage.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['embeddings', 'mcp'],
    confidence: 0.8,
    stability: 'exploratory',
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:third'
  });

  const stale = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Stale recall note',
    summary: 'Stale memories should stay out of default recall',
    content: 'This stale memory is intentionally outdated and should not appear in default workspace recall.',
    status: 'stale',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['lifecycle', 'stale'],
    confidence: 0.4,
    stability: 'volatile',
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:stale'
  });

  const superseded = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Superseded recall note',
    summary: 'Superseded memories should stay out of default recall',
    content: 'This superseded memory is intentionally obsolete and should not appear in default workspace recall.',
    status: 'superseded',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['lifecycle', 'superseded'],
    confidence: 0.4,
    stability: 'volatile',
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:superseded'
  });

  const sourceUpsertInitial = upsertMemoryBySource(memorySystem, {
    type: 'project',
    scope: 'workspace',
    title: 'Source upsert seed',
    summary: 'Canonical source upsert version one',
    content: 'Source upsert content v1.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure/',
    sessionId: 'memory-smoke-test',
    tags: ['upsert'],
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:source-upsert'
  });

  const sourceUpsertUpdated = upsertMemoryBySource(memorySystem, {
    type: 'project',
    scope: 'workspace',
    title: 'Source upsert seed',
    summary: 'Canonical source upsert version two',
    content: 'Source upsert content v2.',
    projectKey: 'workflow-closure',
    workspacePath: 'c:\\workspace\\workflow-closure\\',
    sessionId: 'memory-smoke-test',
    tags: ['upsert', 'updated'],
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:source-upsert',
    message: 'Updated canonical source upsert memory.'
  });

  const semanticAlpha = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Semantic alpha target',
    summary: 'Semantic rerank target',
    content: 'alpha concept note',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['semantic-test'],
    confidence: 0.4,
    stability: 'stable',
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:semantic-alpha'
  });

  const semanticBeta = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Semantic beta distractor',
    summary: 'Lexical baseline distractor',
    content: 'beta concept note',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['semantic-test'],
    confidence: 0.99,
    stability: 'stable',
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:semantic-beta'
  });

  const policyWorkflowId = 'policy-workflow';
  const policyTaskId = 'task-1';
  const policyTaskSourceRef = `workflow:${policyWorkflowId}:task:${policyTaskId}`;
  const policyAssignmentSourceRef = `workflow:${policyWorkflowId}:assignment:${policyTaskId}`;
  const policyStageSourceRef = 'chain:policy-chain:stage:stage-1';

  const policyTaskMemory = memorySystem.remember({
    type: 'project',
    scope: 'workspace',
    title: 'Policy task memory',
    summary: 'Canonical workflow task seed',
    content: 'Canonical workflow task memory used to verify derived policy links.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['policy-test'],
    confidence: 0.8,
    stability: 'stable',
    sourceKind: 'workflow-task',
    sourceRef: policyTaskSourceRef,
    workflowId: policyWorkflowId,
    taskId: policyTaskId
  });

  const flexibleStructuredMemory = memorySystem.remember({
    type: 'reference',
    scope: 'workspace',
    title: 'Flexible structure memory',
    summary: 'Unregistered writes stay permissive',
    content: 'Manual memories should still accept flexible structureJson payloads.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['policy-test'],
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:flexible-structure',
    structureJson: {
      arbitrary: {
        nested: true,
        note: 'kept'
      },
      steps: ['one', 'two']
    }
  });

  const malformedTaskLifecycleError = assertThrows(() => upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowTaskLifecycle',
    type: 'feedback',
    scope: 'workspace',
    title: 'Malformed task lifecycle',
    summary: 'Should fail validation',
    content: 'This write intentionally omits eventKind.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    sourceKind: 'workflow-task',
    sourceRef: policyTaskSourceRef,
    workflowId: policyWorkflowId,
    taskId: policyTaskId,
    structureJson: {
      workflowId: policyWorkflowId,
      taskId: policyTaskId,
      taskTitle: 'Policy task memory'
    }
  }), 'workflowTaskLifecycle.eventKind');

  const policyTaskLifecycleMemory = upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowTaskLifecycle',
    type: 'feedback',
    scope: 'workspace',
    title: 'Workflow task lifecycle',
    summary: 'Policy-backed task lifecycle write',
    content: 'Task lifecycle memory should validate structure and derive task links.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['policy-test'],
    sourceKind: 'workflow-task',
    sourceRef: policyTaskSourceRef,
    subjectKind: 'workflow-task',
    subjectRef: policyTaskSourceRef,
    workflowId: policyWorkflowId,
    taskId: policyTaskId,
    eventKind: 'done',
    structureJson: {
      workflowId: policyWorkflowId,
      taskId: policyTaskId,
      taskTitle: 'Policy task memory',
      taskStatus: 'done',
      eventKind: 'done',
      runnerId: 'runner-policy',
      prompt: 'finish policy task',
      doneSummary: 'Policy task completed.',
      blockedReason: null,
      lastError: null,
      adapterPayload: {
        outcome: 'done'
      },
      contextSnapshotId: 'snapshot-policy-task-1',
      contextItemCount: 2
    }
  });

  const policyTaskLifecycleUpdated = upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowTaskLifecycle',
    type: 'feedback',
    scope: 'workspace',
    title: 'Workflow task lifecycle',
    summary: 'Policy-backed task lifecycle write updated',
    content: 'Task lifecycle memory should keep derived links on repeated source upserts.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['policy-test', 'updated'],
    sourceKind: 'workflow-task',
    sourceRef: policyTaskSourceRef,
    subjectKind: 'workflow-task',
    subjectRef: policyTaskSourceRef,
    workflowId: policyWorkflowId,
    taskId: policyTaskId,
    eventKind: 'blocked',
    structureJson: {
      workflowId: policyWorkflowId,
      taskId: policyTaskId,
      taskTitle: 'Policy task memory',
      taskStatus: 'blocked',
      eventKind: 'blocked',
      runnerId: 'runner-policy-2',
      prompt: 'retry policy task',
      doneSummary: null,
      blockedReason: 'Need review',
      lastError: 'Need review',
      adapterPayload: {
        outcome: 'blocked'
      },
      contextSnapshotId: null,
      contextItemCount: 0
    }
  });
  const malformedPolicyError = assertThrows(() => upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowAssignmentLifecycle',
    type: 'feedback',
    scope: 'workspace',
    title: 'Malformed assignment lifecycle',
    summary: 'Should fail validation',
    content: 'This write intentionally omits taskTitle.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    sourceKind: 'workflow-assignment',
    sourceRef: policyAssignmentSourceRef,
    workflowId: policyWorkflowId,
    taskId: policyTaskId,
    eventKind: 'assigned',
    structureJson: {
      workflowId: policyWorkflowId,
      taskId: policyTaskId,
      eventKind: 'assigned'
    }
  }), 'workflowAssignmentLifecycle.taskTitle');

  const policyAssignmentMemory = upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowAssignmentLifecycle',
    type: 'feedback',
    scope: 'workspace',
    title: 'Workflow assignment lifecycle',
    summary: 'Policy-backed assignment write',
    content: 'Assignment lifecycle memory should validate structure and derive task links.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['policy-test'],
    sourceKind: 'workflow-assignment',
    sourceRef: policyAssignmentSourceRef,
    subjectKind: 'workflow-assignment',
    subjectRef: policyAssignmentSourceRef,
    workflowId: policyWorkflowId,
    taskId: policyTaskId,
    eventKind: 'assigned',
    structureJson: {
      workflowId: policyWorkflowId,
      taskId: policyTaskId,
      taskTitle: 'Policy task memory',
      eventKind: 'assigned',
      assignment: {
        runnerId: 'runner-policy'
      }
    }
  });

  const policyStageMemory = upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'chainStageLifecycle',
    type: 'feedback',
    scope: 'workspace',
    title: 'Chain stage lifecycle',
    summary: 'Policy-backed chain stage write',
    content: 'Chain stage lifecycle memory should derive links to the resumed workflow task.',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    tags: ['policy-test'],
    sourceKind: 'chain-stage',
    sourceRef: policyStageSourceRef,
    workflowId: policyWorkflowId,
    eventKind: 'resumed',
    structureJson: {
      chainId: 'policy-chain',
      stageId: 'stage-1',
      stageTitle: 'Policy stage',
      kind: 'resumed',
      workflowId: policyWorkflowId,
      resumedTaskId: policyTaskId
    }
  });

  assert(first.events.length === 1, 'remember should create an initial event');
  assert(second.links.length === 1, 'remember should return created links');
  assert(stale.memory.status === 'stale', 'remember should persist stale lifecycle status when requested');
  assert(superseded.memory.status === 'superseded', 'remember should persist superseded lifecycle status when requested');
  assert(sourceUpsertUpdated.memory.memoryId === sourceUpsertInitial.memory.memoryId, 'source-based upsert should reuse the same memory across canonical workspace path variants');
  assert(sourceUpsertUpdated.memory.summary === 'Canonical source upsert version two', 'source-based upsert should persist the latest summary');
  assert(sourceUpsertUpdated.lastEvent.action === 'updated', 'source-based upsert should record an updated event when reusing the same memory');
  assert(malformedTaskLifecycleError.message.includes('workflowTaskLifecycle.eventKind'), 'registered task lifecycle policy should reject malformed required structure fields');
  assert(malformedPolicyError.message.includes('workflowAssignmentLifecycle.taskTitle'), 'registered policy writes should reject malformed required structure fields');

  const flexibleStructureState = memorySystem.getMemoryState({
    memoryId: flexibleStructuredMemory.memory.memoryId,
    includeLinks: false,
    limit: 5
  });
  const policyTaskLifecycleState = memorySystem.getMemoryState({
    memoryId: policyTaskLifecycleMemory.memory.memoryId,
    includeLinks: true,
    limit: 20
  });
  const policyAssignmentState = memorySystem.getMemoryState({
    memoryId: policyAssignmentMemory.memory.memoryId,
    includeLinks: true,
    limit: 20
  });
  const policyStageState = memorySystem.getMemoryState({
    memoryId: policyStageMemory.memory.memoryId,
    includeLinks: true,
    limit: 20
  });

  assert(flexibleStructureState.memory.structureJson?.arbitrary?.nested === true, 'unregistered memories should keep flexible structureJson payloads');
  assert(policyTaskLifecycleUpdated.memory.memoryId === policyTaskLifecycleMemory.memory.memoryId, 'task lifecycle policy should reuse the same memory on repeated source upserts');
  assert(policyTaskLifecycleUpdated.memory.summary === 'Policy-backed task lifecycle write updated', 'task lifecycle policy should persist latest content on repeated source upserts');
  assert(policyTaskLifecycleUpdated.lastEvent.action === 'updated', 'task lifecycle policy should record an update event on repeated source upserts');
  assert(policyTaskLifecycleState.memory.sourceRef === policyTaskSourceRef, 'task lifecycle policy should normalize canonical task source refs');
  assert(policyTaskLifecycleState.memory.structureJson?.contextItemCount === 0, 'task lifecycle policy should normalize zero context item counts');
  assert(policyTaskLifecycleState.links.some((link) => link.otherMemoryId === policyTaskLifecycleState.memory.memoryId && link.relation === 'task_lineage'), 'task lifecycle policy should preserve task lineage links on repeated source upserts');
  assert(policyAssignmentState.memory.structureJson?.taskSourceRef === policyTaskSourceRef, 'assignment policy should normalize canonical task source refs');
  assert(policyAssignmentState.links.some((link) => link.otherMemoryId === policyTaskMemory.memory.memoryId && link.relation === 'task_assignment'), 'assignment policy should derive task links automatically');
  assert(policyStageState.links.some((link) => link.otherMemoryId === policyTaskMemory.memory.memoryId && link.relation === 'resumed_task'), 'chain stage policy should derive resumed task links automatically');

  const filtered = memorySystem.recall({
    type: 'project',
    scope: 'workspace',
    projectKey: 'workflow-closure',
    tags: ['architecture']
  });
  assert(filtered.items[0].memoryId === first.memory.memoryId, 'structured recall should find the first memory');
  assert(filtered.items[0].matchedBy.filters.includes('type'), 'structured recall should report matched filters');
  assert(filtered.items[0].matchedBy.filters.includes('tags'), 'structured recall should report tag filtering');
  assert(filtered.items[0].matchedBy.text === false, 'structured recall should not mark a text hit when no text query is used');

  const textHit = memorySystem.recall({
    text: 'standalone vector database',
    scope: 'workspace'
  });

  assert(textHit.total === 1, 'FTS recall should find text that only appears in content');
  assert(textHit.items[0].memoryId === first.memory.memoryId, 'FTS recall should find the first memory');
  assert(textHit.items[0].matchedBy.text === true, 'FTS recall should report a text hit');
  assert(textHit.items[0].matchedBy.semantic === false, 'default recall should not mark semantic hits');
  assert(textHit.diagnostics?.semantic?.enabled === false, 'default recall should keep semantic rerank disabled');

  const punctuatedTextHit = memorySystem.recall({
    text: 'status: archived projectKey: workflow-closure',
    scope: 'workspace'
  });

  assert(punctuatedTextHit.total >= 0, 'FTS recall should safely accept punctuated free-text queries');

  const semanticMemorySystem = await createAgentMemorySystem({
    dbPath,
    semantic: {
      enabled: true,
      candidateLimit: 5,
      weight: 0.5,
      embedder: createSemanticTestEmbedder()
    }
  });

  const semanticDisabledRecall = semanticMemorySystem.recall({
    text: 'alpha beta',
    scope: 'workspace',
    projectKey: 'workflow-closure',
    semantic: false
  });

  assert(semanticDisabledRecall.items[0].memoryId === semanticBeta.memory.memoryId, 'semantic override false should preserve lexical ordering');
  assert(semanticDisabledRecall.diagnostics?.semantic?.applied === false, 'semantic override false should skip reranking');

  const semanticReranked = semanticMemorySystem.recall({
    text: 'alpha beta',
    scope: 'workspace',
    projectKey: 'workflow-closure'
  });

  assert(semanticReranked.diagnostics?.semantic?.applied === true, 'semantic recall should apply reranking when enabled');
  assert(semanticReranked.items[0].memoryId === semanticAlpha.memory.memoryId, 'semantic rerank should reorder lexical candidates');
  assert(semanticReranked.items[0].matchedBy.semantic === true, 'semantic rerank should mark semantic hits');
  assert(typeof semanticReranked.items[0].ranking?.semanticScore === 'number', 'semantic rerank should expose semantic scores');

  const failingSemanticMemorySystem = await createAgentMemorySystem({
    dbPath,
    semantic: {
      enabled: true,
      candidateLimit: 5,
      weight: 0.5,
      embedder: createSemanticTestEmbedder({ fail: true })
    }
  });

  const semanticFallback = failingSemanticMemorySystem.recall({
    text: 'alpha beta',
    scope: 'workspace',
    projectKey: 'workflow-closure'
  });

  assert(semanticFallback.items[0].memoryId === semanticBeta.memory.memoryId, 'semantic fallback should keep lexical ordering');
  assert(semanticFallback.diagnostics?.semantic?.fallbackUsed === true, 'semantic fallback should be reported');
  assert(semanticFallback.diagnostics?.semantic?.error === 'semantic embedder failed', 'semantic fallback should expose the embedder error');

  memorySystem.updateMemory({
    memoryId: semanticAlpha.memory.memoryId,
    summary: 'Semantic rerank target refreshed',
    content: 'beta concept note updated',
    message: 'Refreshed semantic smoke memory.'
  });

  const staleRefreshRecall = semanticMemorySystem.recall({
    text: 'beta',
    scope: 'workspace',
    projectKey: 'workflow-closure'
  });

  assert(staleRefreshRecall.diagnostics?.semantic?.applied === true, 'stale embedding recall should still rerank');
  assert(staleRefreshRecall.diagnostics?.semantic?.staleEmbeddingCount >= 1, 'stale embeddings should be refreshed after memory updates');

  const updated = memorySystem.updateMemory({
    memoryId: first.memory.memoryId,
    summary: 'SQLite-first memory architecture direction',
    content: 'Super memory MVP should stay SQLite-first with hybrid recall, FTS-backed text search, and no standalone vector database in the first version.',
    tags: ['architecture', 'hybrid', 'mvp'],
    links: [
      {
        targetMemoryId: third.memory.memoryId,
        relation: 'related_to'
      }
    ],
    confidence: 0.97,
    message: 'Refined MVP architecture memory.'
  });

  const sourceUpsertRecall = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'memory-smoke-test',
    sourceKind: 'smoke-test',
    sourceRef: 'memory-smoke-test:source-upsert',
    statuses: ['active', 'stale', 'superseded', 'archived'],
    limit: 10
  });

  assert(updated.memory.summary === 'SQLite-first memory architecture direction', 'updateMemory should persist the new summary');
  assert(updated.memory.confidence === 0.97, 'updateMemory should persist numeric changes');
  assert(updated.lastEvent.action === 'updated', 'updateMemory should record an updated event');
  assert(sourceUpsertRecall.total === 1, 'source-based upsert should not leave multiple records for the same canonical source identity');
  assert(sourceUpsertRecall.items[0].memoryId === sourceUpsertInitial.memory.memoryId, 'source-based upsert recall should resolve to the original memory id');
  assert(sourceUpsertRecall.items[0].content === 'Source upsert content v2.', 'source-based upsert recall should expose the latest content');

  const inspected = memorySystem.getMemoryState({
    memoryId: first.memory.memoryId,
    includeEvents: true,
    includeLinks: true,
    limit: 20
  });

  assert(inspected.memory.memoryId === first.memory.memoryId, 'getMemoryState should return the requested memory');
  assert(inspected.tags.some((tag) => tag.tag === 'hybrid'), 'getMemoryState should return replaced tags');
  assert(inspected.links.some((link) => link.otherMemoryId === third.memory.memoryId), 'getMemoryState should include newly added links');
  assert(inspected.events.some((event) => event.action === 'created'), 'getMemoryState should include the created event');
  assert(inspected.events.some((event) => event.action === 'updated'), 'getMemoryState should include the updated event');
  assert(inspected.events.some((event) => event.action === 'recalled'), 'recall should append recalled events');

  const archived = memorySystem.archiveMemory({
    memoryId: second.memory.memoryId,
    reason: 'Archived by smoke test.'
  });

  assert(archived.memory.status === 'archived', 'archiveMemory should mark the memory as archived');
  assert(archived.lastEvent.action === 'archived', 'archiveMemory should record an archived event');

  const activeRecall = memorySystem.recall({
    scope: 'workspace',
    projectKey: 'workflow-closure'
  });
  assert(activeRecall.items.every((item) => item.status === 'active'), 'default recall should only return active memories');
  assert(activeRecall.items.every((item) => item.memoryId !== second.memory.memoryId), 'default recall should not return the archived memory');
  assert(activeRecall.items.every((item) => item.memoryId !== stale.memory.memoryId), 'default recall should not return stale memories');
  assert(activeRecall.items.every((item) => item.memoryId !== superseded.memory.memoryId), 'default recall should not return superseded memories');

  const staleAndSupersededRecall = memorySystem.recall({
    statuses: ['stale', 'superseded'],
    scope: 'workspace',
    projectKey: 'workflow-closure',
    sessionId: 'memory-smoke-test',
    limit: 10
  });
  assert(staleAndSupersededRecall.items.some((item) => item.memoryId === stale.memory.memoryId), 'explicit status recall should include stale memories');
  assert(staleAndSupersededRecall.items.some((item) => item.memoryId === superseded.memory.memoryId), 'explicit status recall should include superseded memories');

  const archivedRecall = memorySystem.recall({
    status: 'archived',
    projectKey: 'workflow-closure'
  });
  assert(archivedRecall.total === 1, 'archived recall should return archived memories when requested');
  assert(archivedRecall.items[0].memoryId === second.memory.memoryId, 'archived recall should find the archived memory');

  console.log('memory smoke test passed');
  console.log(JSON.stringify({
    createdMemoryIds: [first.memory.memoryId, second.memory.memoryId, third.memory.memoryId],
    staleMemoryId: stale.memory.memoryId,
    supersededMemoryId: superseded.memory.memoryId,
    sourceUpsertMemoryId: sourceUpsertInitial.memory.memoryId,
    filteredTotal: filtered.total,
    textHitTotal: textHit.total,
    archivedMemoryId: archived.memory.memoryId,
    activeRecallTotal: activeRecall.total,
    staleAndSupersededRecallTotal: staleAndSupersededRecall.total,
    archivedRecallTotal: archivedRecall.total
  }, null, 2));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(fn, expectedMessageFragment) {
  try {
    fn();
  } catch (error) {
    if (expectedMessageFragment && !String(error?.message || '').includes(expectedMessageFragment)) {
      throw new Error(`Expected error message to include "${expectedMessageFragment}", got "${error?.message || error}"`);
    }
    return error;
  }

  throw new Error(`Expected function to throw${expectedMessageFragment ? ` (${expectedMessageFragment})` : ''}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  closeDb();
});
