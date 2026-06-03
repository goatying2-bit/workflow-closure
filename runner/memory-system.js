import { normalizeWorkspacePath } from '../storage/db.js';
import { initializeMemoryStore, getMemoryStore } from '../storage/memories.js';

const DEFAULT_MEMORY_SCOPE = 'workspace';
const DEFAULT_RECALL_LIMIT = 5;
const UPSERT_RECALL_STATUSES = Object.freeze(['active', 'stale', 'superseded', 'archived']);
const MEMORY_WRITE_POLICIES = Object.freeze({
  workflowTaskLifecycle: {
    key: 'workflowTaskLifecycle',
    normalizeStructure: normalizeWorkflowTaskLifecycleStructure,
    deriveLinkTargets: deriveWorkflowTaskLifecycleLinkTargets
  },
  workflowTaskResumed: {
    key: 'workflowTaskResumed',
    normalizeStructure: normalizeWorkflowTaskResumedStructure,
    deriveLinkTargets: deriveWorkflowTaskResumedLinkTargets
  },
  workflowTaskRerun: {
    key: 'workflowTaskRerun',
    normalizeStructure: normalizeWorkflowTaskRerunStructure,
    deriveLinkTargets: deriveWorkflowTaskRerunLinkTargets
  },
  workflowAssignmentLifecycle: {
    key: 'workflowAssignmentLifecycle',
    normalizeStructure: normalizeWorkflowAssignmentLifecycleStructure,
    deriveLinkTargets: deriveWorkflowAssignmentLifecycleLinkTargets
  },
  chainStageLifecycle: {
    key: 'chainStageLifecycle',
    normalizeStructure: normalizeChainStageLifecycleStructure,
    deriveLinkTargets: deriveChainStageLifecycleLinkTargets
  }
});

export async function createAgentMemorySystem(options = {}) {
  await initializeMemoryStore(options);
  const store = getMemoryStore(options);
  const defaultBoundary = resolveMemoryBoundaryDefaults(options);

  return {
    remember(input = {}) {
      return store.createMemory(normalizeRememberInput(applyMemoryBoundaryDefaults(input, defaultBoundary)));
    },
    updateMemory(input = {}) {
      return store.updateMemory(normalizeUpdateInput(applyMemoryBoundaryDefaultsToUpdate(input, defaultBoundary)));
    },
    recall(query = {}) {
      return store.recall(normalizeRecallQuery(applyMemoryBoundaryDefaults(query, defaultBoundary)));
    },
    getMemoryState(input = {}) {
      const memoryId = normalizeRequiredText(input.memoryId, 'Memory id');
      return store.getMemoryState(memoryId, {
        includeEvents: Boolean(input.includeEvents),
        includeLinks: input.includeLinks !== false,
        limit: input.limit
      });
    },
    archiveMemory(input = {}) {
      const memoryId = normalizeRequiredText(input.memoryId, 'Memory id');
      return store.archiveMemory({
        memoryId,
        reason: normalizeOptionalText(input.reason)
      });
    }
  };
}

export async function resolveAgentMemorySystem(options = {}) {
  if (isMemorySystem(options.memorySystem)) {
    return options.memorySystem;
  }

  const memoryOptions = normalizeMemoryOptions(options.memory);

  if (!memoryOptions) {
    return null;
  }

  if (isMemorySystem(options.memory)) {
    return options.memory;
  }

  if (isMemorySystem(memoryOptions.system)) {
    return memoryOptions.system;
  }

  return createAgentMemorySystem({
    dbPath: memoryOptions.dbPath || options.dbPath,
    scope: memoryOptions.scope ?? options.scope,
    projectKey: memoryOptions.projectKey ?? options.projectKey,
    workspacePath: normalizeWorkspacePath(memoryOptions.workspacePath ?? options.workspacePath),
    sessionId: memoryOptions.sessionId ?? options.sessionId,
    semantic: memoryOptions.semantic
  });
}

export function resolveMemoryIntegrationContext(options = {}) {
  const memoryOptions = normalizeMemoryOptions(options.memory);

  return {
    enabled: Boolean(memoryOptions),
    scope: normalizeOptionalText(memoryOptions?.scope) || normalizeOptionalText(options.scope) || DEFAULT_MEMORY_SCOPE,
    projectKey: normalizeOptionalText(memoryOptions?.projectKey) || normalizeOptionalText(options.projectKey),
    workspacePath: normalizeWorkspacePath(memoryOptions?.workspacePath ?? options.workspacePath),
    sessionId: normalizeOptionalText(memoryOptions?.sessionId) || normalizeOptionalText(options.sessionId),
    limit: normalizePositiveInteger(memoryOptions?.limit ?? options.memoryLimit ?? DEFAULT_RECALL_LIMIT, 'Memory recall limit')
  };
}

export function upsertMemoryBySource(memorySystem, input = {}) {
  if (!memorySystem) {
    return null;
  }

  const preprocessed = preprocessMemoryWriteInput(memorySystem, input);
  const type = normalizeRequiredText(preprocessed.type, 'Memory type');
  const scope = normalizeRequiredText(preprocessed.scope, 'Memory scope');
  const title = normalizeOptionalText(preprocessed.title);
  const summary = normalizeOptionalText(preprocessed.summary);
  const content = normalizeRequiredText(preprocessed.content, 'Memory content');
  const sourceKind = normalizeRequiredText(preprocessed.sourceKind, 'Memory sourceKind');
  const sourceRef = normalizeRequiredText(preprocessed.sourceRef, 'Memory sourceRef');
  const tags = normalizeOptionalArray(preprocessed.tags, 'tags') || [];
  const workspacePath = normalizeWorkspacePath(preprocessed.workspacePath);
  const subjectKind = normalizeOptionalText(preprocessed.subjectKind);
  const subjectRef = normalizeOptionalText(preprocessed.subjectRef);
  const workflowId = normalizeOptionalText(preprocessed.workflowId);
  const taskId = normalizeOptionalText(preprocessed.taskId);
  const eventKind = normalizeOptionalText(preprocessed.eventKind);
  const structureJson = hasOwn(preprocessed, 'structureJson') || hasOwn(preprocessed, 'structure')
    ? normalizeOptionalStructureValue(hasOwn(preprocessed, 'structureJson') ? preprocessed.structureJson : preprocessed.structure)
    : null;
  const query = {
    scope,
    sourceKind,
    sourceRef,
    statuses: UPSERT_RECALL_STATUSES,
    limit: 5
  };

  if (preprocessed.projectKey != null) {
    query.projectKey = normalizeRequiredText(preprocessed.projectKey, 'projectKey');
  }

  if (workspacePath != null) {
    query.workspacePath = workspacePath;
  }

  if (preprocessed.sessionId != null) {
    query.sessionId = normalizeRequiredText(preprocessed.sessionId, 'sessionId');
  }

  const recalled = memorySystem.recall(query);
  const existing = recalled.items[0] || null;
  const links = resolveDerivedLinks(memorySystem, existing, preprocessed.links);

  if (existing) {
    return memorySystem.updateMemory({
      memoryId: existing.memoryId,
      type,
      scope,
      title,
      summary,
      content,
      projectKey: normalizeOptionalText(preprocessed.projectKey),
      workspacePath,
      sessionId: normalizeOptionalText(preprocessed.sessionId),
      tags,
      links,
      sourceKind,
      sourceRef,
      subjectKind,
      subjectRef,
      workflowId,
      taskId,
      eventKind,
      structureJson,
      ...(hasOwn(preprocessed, 'confidence')
        ? { confidence: preprocessed.confidence == null ? null : normalizeNumber(preprocessed.confidence, 'confidence') }
        : {}),
      stability: normalizeOptionalText(preprocessed.stability),
      message: normalizeOptionalText(preprocessed.message)
    });
  }

  return memorySystem.remember({
    type,
    scope,
    title,
    summary,
    content,
    projectKey: normalizeOptionalText(preprocessed.projectKey),
    workspacePath,
    sessionId: normalizeOptionalText(preprocessed.sessionId),
    tags,
    links,
    sourceKind,
    sourceRef,
    subjectKind,
    subjectRef,
    workflowId,
    taskId,
    eventKind,
    structureJson,
    ...(hasOwn(preprocessed, 'confidence')
      ? { confidence: preprocessed.confidence == null ? null : normalizeNumber(preprocessed.confidence, 'confidence') }
      : {}),
    stability: normalizeOptionalText(preprocessed.stability)
  });
}


function preprocessMemoryWriteInput(memorySystem, input = {}) {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const policy = resolveMemoryWritePolicy(input.memoryPolicy);
  if (!policy) {
    return input;
  }

  const output = { ...input };
  const rawStructure = hasOwn(output, 'structureJson') ? output.structureJson : output.structure;
  const normalizedStructure = normalizeOptionalStructureValue(rawStructure);
  output.structureJson = policy.normalizeStructure(normalizedStructure, output);
  delete output.structure;

  const derivedLinks = policy.deriveLinkTargets({
    memorySystem,
    input: output
  });
  const explicitLinks = normalizeInputLinkTargets(output.links);
  output.links = mergeDerivedLinkTargets(explicitLinks, derivedLinks);
  return output;
}

function resolveMemoryWritePolicy(value) {
  const key = normalizeOptionalText(value);
  if (!key) {
    return null;
  }

  if (!hasOwn(MEMORY_WRITE_POLICIES, key)) {
    throw new Error(`Unknown memoryPolicy "${key}".`);
  }

  return MEMORY_WRITE_POLICIES[key];
}

function resolveDerivedLinks(memorySystem, existing, links) {
  const pendingLinks = normalizeInputLinkTargets(links);
  const resolvedExplicitLinks = resolvePendingLinkTargets(memorySystem, pendingLinks);
  if (!existing) {
    return resolvedExplicitLinks;
  }

  const existingLinks = Array.isArray(existing.links)
    ? existing.links
        .filter((link) => link && typeof link === 'object' && link.direction === 'outgoing')
        .map((link) => ({
          targetMemoryId: normalizeRequiredText(link.targetMemoryId, 'Existing link targetMemoryId'),
          relation: normalizeRequiredText(link.relation, 'Existing link relation')
        }))
    : [];

  return dedupeLinkTargets([...existingLinks, ...resolvedExplicitLinks]);
}

function resolvePendingLinkTargets(memorySystem, links) {
  const resolved = [];

  for (const link of Array.isArray(links) ? links : []) {
    const targetMemoryId = normalizeOptionalText(link?.targetMemoryId);
    if (targetMemoryId) {
      resolved.push({
        relation: normalizeRequiredText(link.relation, 'Link relation'),
        targetMemoryId
      });
      continue;
    }

    const sourceKind = normalizeOptionalText(link?.sourceKind);
    const sourceRef = normalizeOptionalText(link?.sourceRef);
    if (!sourceKind || !sourceRef) {
      continue;
    }

    resolved.push(...resolveSourceRefLinkTargets(memorySystem, [{
      relation: normalizeRequiredText(link.relation, 'Link relation'),
      sourceKind,
      sourceRef
    }]));
  }

  return dedupeLinkTargets(resolved);
}

function normalizeInputLinkTargets(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('links must be an array.');
  }

  return value.map((link, index) => {
    if (!link || typeof link !== 'object') {
      throw new Error(`Link at index ${index} must be an object.`);
    }

    return {
      relation: normalizeRequiredText(link.relation, `Link relation at index ${index}`),
      sourceKind: normalizeOptionalText(link.sourceKind),
      sourceRef: normalizeOptionalText(link.sourceRef),
      targetMemoryId: normalizeOptionalText(link.targetMemoryId)
    };
  });
}

function mergeDerivedLinkTargets(explicitLinks, derivedLinks) {
  return dedupeLinkTargets([
    ...(Array.isArray(explicitLinks) ? explicitLinks : []),
    ...(Array.isArray(derivedLinks) ? derivedLinks : [])
  ]);
}

function dedupeLinkTargets(links) {
  const deduped = [];
  const seen = new Set();

  for (const link of Array.isArray(links) ? links : []) {
    if (!link || typeof link !== 'object') {
      continue;
    }

    const relation = normalizeRequiredText(link.relation, 'Link relation');
    const targetMemoryId = normalizeOptionalText(link.targetMemoryId);
    const sourceKind = normalizeOptionalText(link.sourceKind);
    const sourceRef = normalizeOptionalText(link.sourceRef);
    const key = `${relation}::${targetMemoryId || ''}::${sourceKind || ''}::${sourceRef || ''}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      relation,
      targetMemoryId,
      sourceKind,
      sourceRef
    });
  }

  return deduped;
}

function normalizePolicyStructureObject(structureJson, label) {
  if (!structureJson || typeof structureJson !== 'object' || Array.isArray(structureJson)) {
    throw new Error(`${label} structureJson must be an object.`);
  }

  return structureJson;
}

function normalizeRequiredStructureText(structureJson, key, label) {
  return normalizeRequiredText(structureJson?.[key], `${label}.${key}`);
}

function normalizeWorkflowTaskLifecycleStructure(structureJson, input) {
  const structure = normalizePolicyStructureObject(structureJson, 'workflowTaskLifecycle');
  const workflowId = normalizeRequiredStructureText(structure, 'workflowId', 'workflowTaskLifecycle');
  const taskId = normalizeRequiredStructureText(structure, 'taskId', 'workflowTaskLifecycle');

  return {
    workflowId,
    taskId,
    taskTitle: normalizeRequiredStructureText(structure, 'taskTitle', 'workflowTaskLifecycle'),
    taskStatus: normalizeOptionalText(structure.taskStatus),
    eventKind: normalizeRequiredStructureText(structure, 'eventKind', 'workflowTaskLifecycle'),
    runnerId: normalizeOptionalText(structure.runnerId),
    prompt: normalizeOptionalText(structure.prompt),
    doneSummary: normalizeOptionalText(structure.doneSummary),
    blockedReason: normalizeOptionalText(structure.blockedReason),
    lastError: normalizeOptionalText(structure.lastError),
    adapterPayload: structure.adapterPayload ?? null,
    contextSnapshotId: normalizeOptionalText(structure.contextSnapshotId),
    contextItemCount: structure.contextItemCount == null
      ? 0
      : normalizeOptionalPositiveInteger(structure.contextItemCount, { allowZero: true }),
    sourceRef: normalizeOptionalText(input.sourceRef) || createWorkflowTaskSourceRef(workflowId, taskId)
  };
}

function normalizeWorkflowTaskResumedStructure(structureJson, input) {
  const structure = normalizePolicyStructureObject(structureJson, 'workflowTaskResumed');
  const workflowId = normalizeRequiredStructureText(structure, 'workflowId', 'workflowTaskResumed');
  const taskId = normalizeRequiredStructureText(structure, 'taskId', 'workflowTaskResumed');

  return {
    workflowId,
    taskId,
    taskTitle: normalizeRequiredStructureText(structure, 'taskTitle', 'workflowTaskResumed'),
    taskStatus: normalizeOptionalText(structure.taskStatus),
    previousStatus: normalizeOptionalText(structure.previousStatus),
    blockedReason: normalizeOptionalText(structure.blockedReason),
    lastError: normalizeOptionalText(structure.lastError),
    resumeMessage: normalizeOptionalText(structure.resumeMessage),
    resumePayload: structure.resumePayload ?? null,
    sourceRef: normalizeOptionalText(input.sourceRef) || createWorkflowTaskSourceRef(workflowId, taskId)
  };
}

function normalizeWorkflowTaskRerunStructure(structureJson, input) {
  const structure = normalizePolicyStructureObject(structureJson, 'workflowTaskRerun');
  const workflowId = normalizeRequiredStructureText(structure, 'workflowId', 'workflowTaskRerun');
  const taskId = normalizeRequiredStructureText(structure, 'taskId', 'workflowTaskRerun');
  const descendantTaskIds = Array.isArray(structure.descendantTaskIds)
    ? structure.descendantTaskIds.map((value, index) => normalizeRequiredText(value, `workflowTaskRerun.descendantTaskIds[${index}]`))
    : [];

  return {
    workflowId,
    taskId,
    taskTitle: normalizeRequiredStructureText(structure, 'taskTitle', 'workflowTaskRerun'),
    taskStatus: normalizeOptionalText(structure.taskStatus),
    rerunId: normalizeOptionalText(structure.rerunId),
    rerunReason: normalizeOptionalText(structure.rerunReason),
    rerunFingerprint: normalizeOptionalText(structure.rerunFingerprint),
    rerunOperator: normalizeOptionalText(structure.rerunOperator),
    previousStatus: normalizeOptionalText(structure.previousStatus),
    previousDoneSummary: normalizeOptionalText(structure.previousDoneSummary),
    previousBlockedReason: normalizeOptionalText(structure.previousBlockedReason),
    lastError: normalizeOptionalText(structure.lastError),
    rerunPayload: structure.rerunPayload ?? null,
    descendantTaskIds,
    descendantTaskCount: structure.descendantTaskCount == null ? descendantTaskIds.length : normalizePositiveInteger(structure.descendantTaskCount, 'workflowTaskRerun.descendantTaskCount'),
    sourceRef: normalizeOptionalText(input.sourceRef) || createWorkflowTaskSourceRef(workflowId, taskId)
  };
}

function normalizeWorkflowAssignmentLifecycleStructure(structureJson, input) {
  const structure = normalizePolicyStructureObject(structureJson, 'workflowAssignmentLifecycle');
  const workflowId = normalizeRequiredStructureText(structure, 'workflowId', 'workflowAssignmentLifecycle');
  const taskId = normalizeRequiredStructureText(structure, 'taskId', 'workflowAssignmentLifecycle');

  return {
    workflowId,
    taskId,
    taskTitle: normalizeRequiredStructureText(structure, 'taskTitle', 'workflowAssignmentLifecycle'),
    eventKind: normalizeRequiredStructureText(structure, 'eventKind', 'workflowAssignmentLifecycle'),
    assignment: structure.assignment && typeof structure.assignment === 'object' ? structure.assignment : null,
    handoff: structure.handoff && typeof structure.handoff === 'object' ? structure.handoff : null,
    runnerId: normalizeOptionalText(structure.runnerId),
    error: normalizeOptionalText(structure.error),
    sourceRef: normalizeOptionalText(input.sourceRef) || createWorkflowAssignmentSourceRef(workflowId, taskId),
    taskSourceRef: createWorkflowTaskSourceRef(workflowId, taskId)
  };
}

function normalizeChainStageLifecycleStructure(structureJson, input) {
  const structure = normalizePolicyStructureObject(structureJson, 'chainStageLifecycle');
  const chainId = normalizeRequiredStructureText(structure, 'chainId', 'chainStageLifecycle');
  const stageId = normalizeRequiredStructureText(structure, 'stageId', 'chainStageLifecycle');
  const rerunDescendantStageIds = Array.isArray(structure.rerunDescendantStageIds)
    ? structure.rerunDescendantStageIds.map((value, index) => normalizeRequiredText(value, `chainStageLifecycle.rerunDescendantStageIds[${index}]`))
    : [];

  return {
    chainId,
    stageId,
    stageTitle: normalizeRequiredStructureText(structure, 'stageTitle', 'chainStageLifecycle'),
    kind: normalizeRequiredStructureText(structure, 'kind', 'chainStageLifecycle'),
    workflowId: normalizeOptionalText(structure.workflowId),
    stageStatus: normalizeOptionalText(structure.stageStatus),
    doneSummary: normalizeOptionalText(structure.doneSummary),
    blockedReason: normalizeOptionalText(structure.blockedReason),
    resumedTaskId: normalizeOptionalText(structure.resumedTaskId),
    resumeMessage: normalizeOptionalText(structure.resumeMessage),
    resumePayload: structure.resumePayload ?? null,
    rerunId: normalizeOptionalText(structure.rerunId),
    rerunReason: normalizeOptionalText(structure.rerunReason),
    rerunFingerprint: normalizeOptionalText(structure.rerunFingerprint),
    rerunOperator: normalizeOptionalText(structure.rerunOperator),
    rerunOriginTaskId: normalizeOptionalText(structure.rerunOriginTaskId),
    rerunPayload: structure.rerunPayload ?? null,
    rerunDescendantStageIds,
    workflowRestartTaskId: normalizeOptionalText(structure.workflowRestartTaskId),
    workflowResultStatus: normalizeOptionalText(structure.workflowResultStatus),
    workflowStatus: normalizeOptionalText(structure.workflowStatus),
    previousStageStatus: normalizeOptionalText(structure.previousStageStatus),
    previousWorkflowId: normalizeOptionalText(structure.previousWorkflowId),
    sourceRef: normalizeOptionalText(input.sourceRef) || createChainStageSourceRef(chainId, stageId)
  };
}

function deriveWorkflowTaskLifecycleLinkTargets({ memorySystem, input }) {
  return resolveSourceRefLinkTargets(memorySystem, [
    {
      relation: 'task_lineage',
      sourceKind: normalizeOptionalText(input.sourceKind) || 'workflow-task',
      sourceRef: normalizeOptionalText(input.sourceRef)
    }
  ]);
}

function deriveWorkflowTaskResumedLinkTargets({ memorySystem, input }) {
  return resolveSourceRefLinkTargets(memorySystem, [
    {
      relation: 'task_lineage',
      sourceKind: normalizeOptionalText(input.sourceKind) || 'workflow-task',
      sourceRef: normalizeOptionalText(input.sourceRef)
    }
  ]);
}

function deriveWorkflowTaskRerunLinkTargets({ memorySystem, input }) {
  const structure = input.structureJson;
  const workflowId = normalizeOptionalText(input.workflowId) || normalizeOptionalText(structure?.workflowId);
  const taskId = normalizeOptionalText(input.taskId) || normalizeOptionalText(structure?.taskId);
  const descendantTaskIds = Array.isArray(structure?.descendantTaskIds) ? structure.descendantTaskIds : [];
  const seeds = [
    {
      relation: 'task_lineage',
      sourceKind: 'workflow-task',
      sourceRef: normalizeOptionalText(input.sourceRef) || (workflowId && taskId ? createWorkflowTaskSourceRef(workflowId, taskId) : null)
    }
  ];

  for (const descendantTaskId of descendantTaskIds) {
    if (!workflowId || !descendantTaskId) {
      continue;
    }

    seeds.push({
      relation: 'rerun_descendant',
      sourceKind: 'workflow-task',
      sourceRef: createWorkflowTaskSourceRef(workflowId, descendantTaskId)
    });
  }

  return resolveSourceRefLinkTargets(memorySystem, seeds);
}

function deriveWorkflowAssignmentLifecycleLinkTargets({ memorySystem, input }) {
  const workflowId = normalizeOptionalText(input.workflowId) || normalizeOptionalText(input.structureJson?.workflowId);
  const taskId = normalizeOptionalText(input.taskId) || normalizeOptionalText(input.structureJson?.taskId);

  return resolveSourceRefLinkTargets(memorySystem, [
    {
      relation: 'task_assignment',
      sourceKind: 'workflow-task',
      sourceRef: workflowId && taskId ? createWorkflowTaskSourceRef(workflowId, taskId) : null
    },
    {
      relation: 'assignment_lineage',
      sourceKind: 'workflow-assignment',
      sourceRef: normalizeOptionalText(input.sourceRef) || (workflowId && taskId ? createWorkflowAssignmentSourceRef(workflowId, taskId) : null)
    }
  ]);
}

function deriveChainStageLifecycleLinkTargets({ memorySystem, input }) {
  const structure = input.structureJson;
  const workflowId = normalizeOptionalText(input.workflowId) || normalizeOptionalText(structure?.workflowId);
  const seeds = [];

  if (normalizeOptionalText(input.sourceRef)) {
    seeds.push({
      relation: 'stage_lineage',
      sourceKind: normalizeOptionalText(input.sourceKind) || 'chain-stage',
      sourceRef: normalizeOptionalText(input.sourceRef)
    });
  }

  if (workflowId && normalizeOptionalText(structure?.workflowRestartTaskId)) {
    seeds.push({
      relation: 'workflow_restart',
      sourceKind: 'workflow-task',
      sourceRef: createWorkflowTaskSourceRef(workflowId, structure.workflowRestartTaskId)
    });
  }

  if (workflowId && normalizeOptionalText(structure?.resumedTaskId)) {
    seeds.push({
      relation: 'resumed_task',
      sourceKind: 'workflow-task',
      sourceRef: createWorkflowTaskSourceRef(workflowId, structure.resumedTaskId)
    });
  }

  if (workflowId && normalizeOptionalText(structure?.rerunOriginTaskId)) {
    seeds.push({
      relation: 'rerun_origin',
      sourceKind: 'workflow-task',
      sourceRef: createWorkflowTaskSourceRef(workflowId, structure.rerunOriginTaskId)
    });
  }

  return resolveSourceRefLinkTargets(memorySystem, seeds);
}

function resolveSourceRefLinkTargets(memorySystem, candidates) {
  const links = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const relation = normalizeOptionalText(candidate?.relation);
    const sourceKind = normalizeOptionalText(candidate?.sourceKind);
    const sourceRef = normalizeOptionalText(candidate?.sourceRef);
    if (!relation || !sourceKind || !sourceRef) {
      continue;
    }

    const recalled = memorySystem.recall({
      sourceKind,
      sourceRef,
      statuses: UPSERT_RECALL_STATUSES,
      limit: 5
    });

    for (const item of Array.isArray(recalled?.items) ? recalled.items : []) {
      if (!item?.memoryId) {
        continue;
      }

      links.push({
        relation,
        targetMemoryId: item.memoryId
      });
    }
  }

  return dedupeLinkTargets(links);
}

export function createWorkflowTaskSourceRef(workflowId, taskId) {
  return `workflow:${workflowId}:task:${taskId}`;
}

export function createWorkflowAssignmentSourceRef(workflowId, taskId) {
  return `workflow:${workflowId}:assignment:${taskId}`;
}

export function createChainStageSourceRef(chainId, stageId) {
  return `chain:${chainId}:stage:${stageId}`;
}

function resolveMemoryBoundaryDefaults(options = {}) {
  const memoryOptions = normalizeMemoryOptions(options.memory);

  return {
    scope: normalizeOptionalText(memoryOptions?.scope) || normalizeOptionalText(options.scope) || DEFAULT_MEMORY_SCOPE,
    projectKey: normalizeOptionalText(memoryOptions?.projectKey) || normalizeOptionalText(options.projectKey),
    workspacePath: normalizeWorkspacePath(memoryOptions?.workspacePath ?? options.workspacePath),
    sessionId: normalizeOptionalText(memoryOptions?.sessionId) || normalizeOptionalText(options.sessionId)
  };
}

function applyMemoryBoundaryDefaults(input, defaultBoundary) {
  return applyBoundaryDefaults(input, defaultBoundary);
}

function applyMemoryBoundaryDefaultsToUpdate(input, defaultBoundary) {
  return applyBoundaryDefaults(input, defaultBoundary);
}

function applyBoundaryDefaults(input, defaultBoundary = {}) {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const output = { ...input };

  if (!hasOwn(output, 'scope') && defaultBoundary.scope != null) {
    output.scope = defaultBoundary.scope;
  }

  if (!hasOwn(output, 'projectKey') && defaultBoundary.projectKey != null) {
    output.projectKey = defaultBoundary.projectKey;
  }

  if (!hasOwn(output, 'workspacePath') && defaultBoundary.workspacePath != null) {
    output.workspacePath = defaultBoundary.workspacePath;
  }

  if (!hasOwn(output, 'sessionId') && defaultBoundary.sessionId != null) {
    output.sessionId = defaultBoundary.sessionId;
  }

  return output;
}

function normalizeRememberInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Memory input is required.');
  }

  return {
    memoryId: normalizeOptionalText(input.memoryId),
    type: normalizeRequiredText(input.type, 'Memory type'),
    scope: normalizeRequiredText(input.scope, 'Memory scope'),
    title: normalizeOptionalText(input.title),
    summary: normalizeOptionalText(input.summary),
    content: normalizeRequiredText(input.content, 'Memory content'),
    status: input.status == null ? undefined : normalizeRequiredText(input.status, 'Memory status'),
    projectKey: normalizeOptionalText(input.projectKey),
    workspacePath: normalizeWorkspacePath(input.workspacePath),
    sessionId: normalizeOptionalText(input.sessionId),
    tags: normalizeOptionalArray(input.tags, 'tags'),
    links: normalizeOptionalLinks(input.links),
    sourceKind: normalizeOptionalText(input.sourceKind),
    sourceRef: normalizeOptionalText(input.sourceRef),
    subjectKind: normalizeOptionalText(input.subjectKind),
    subjectRef: normalizeOptionalText(input.subjectRef),
    workflowId: normalizeOptionalText(input.workflowId),
    taskId: normalizeOptionalText(input.taskId),
    eventKind: normalizeOptionalText(input.eventKind),
    structureJson: hasOwn(input, 'structureJson') || hasOwn(input, 'structure')
      ? normalizeOptionalStructureValue(hasOwn(input, 'structureJson') ? input.structureJson : input.structure)
      : undefined,
    confidence: input.confidence == null ? undefined : normalizeNumber(input.confidence, 'confidence'),
    stability: normalizeOptionalText(input.stability)
  };
}

function normalizeUpdateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Memory update input is required.');
  }

  const output = {
    memoryId: normalizeRequiredText(input.memoryId, 'Memory id')
  };

  if (hasOwn(input, 'type')) {
    output.type = normalizeRequiredText(input.type, 'Memory type');
  }

  if (hasOwn(input, 'scope')) {
    output.scope = normalizeRequiredText(input.scope, 'Memory scope');
  }

  if (hasOwn(input, 'title')) {
    output.title = normalizeOptionalText(input.title);
  }

  if (hasOwn(input, 'summary')) {
    output.summary = normalizeOptionalText(input.summary);
  }

  if (hasOwn(input, 'content')) {
    output.content = normalizeRequiredText(input.content, 'Memory content');
  }

  if (hasOwn(input, 'status')) {
    output.status = normalizeRequiredText(input.status, 'Memory status');
  }

  if (hasOwn(input, 'projectKey')) {
    output.projectKey = normalizeOptionalText(input.projectKey);
  }

  if (hasOwn(input, 'workspacePath')) {
    output.workspacePath = normalizeWorkspacePath(input.workspacePath);
  }

  if (hasOwn(input, 'sessionId')) {
    output.sessionId = normalizeOptionalText(input.sessionId);
  }

  if (hasOwn(input, 'tags')) {
    output.tags = normalizeOptionalArray(input.tags, 'tags') || [];
  }

  if (hasOwn(input, 'links')) {
    output.links = normalizeOptionalLinks(input.links) || [];
  }

  if (hasOwn(input, 'sourceKind')) {
    output.sourceKind = normalizeOptionalText(input.sourceKind);
  }

  if (hasOwn(input, 'sourceRef')) {
    output.sourceRef = normalizeOptionalText(input.sourceRef);
  }

  if (hasOwn(input, 'subjectKind')) {
    output.subjectKind = normalizeOptionalText(input.subjectKind);
  }

  if (hasOwn(input, 'subjectRef')) {
    output.subjectRef = normalizeOptionalText(input.subjectRef);
  }

  if (hasOwn(input, 'workflowId')) {
    output.workflowId = normalizeOptionalText(input.workflowId);
  }

  if (hasOwn(input, 'taskId')) {
    output.taskId = normalizeOptionalText(input.taskId);
  }

  if (hasOwn(input, 'eventKind')) {
    output.eventKind = normalizeOptionalText(input.eventKind);
  }

  if (hasOwn(input, 'structureJson') || hasOwn(input, 'structure')) {
    output.structureJson = normalizeOptionalStructureValue(hasOwn(input, 'structureJson') ? input.structureJson : input.structure);
  }

  if (hasOwn(input, 'confidence')) {
    output.confidence = input.confidence == null ? null : normalizeNumber(input.confidence, 'confidence');
  }

  if (hasOwn(input, 'stability')) {
    output.stability = normalizeOptionalText(input.stability);
  }

  if (hasOwn(input, 'message')) {
    output.message = normalizeOptionalText(input.message);
  }

  return output;
}

function normalizeRecallQuery(query) {
  if (query == null) {
    return {};
  }

  if (typeof query !== 'object') {
    throw new Error('Recall query must be an object.');
  }

  const output = {};

  if (hasOwn(query, 'text')) {
    output.text = normalizeOptionalText(query.text);
  }

  if (hasOwn(query, 'type')) {
    output.type = normalizeOptionalText(query.type);
  }

  if (hasOwn(query, 'scope')) {
    output.scope = normalizeOptionalText(query.scope);
  }

  if (hasOwn(query, 'projectKey')) {
    output.projectKey = normalizeOptionalText(query.projectKey);
  }

  if (hasOwn(query, 'workspacePath')) {
    output.workspacePath = normalizeWorkspacePath(query.workspacePath);
  }

  if (hasOwn(query, 'sessionId')) {
    output.sessionId = normalizeOptionalText(query.sessionId);
  }

  if (hasOwn(query, 'statuses')) {
    output.statuses = normalizeOptionalTextArray(query.statuses, 'statuses');
  } else if (hasOwn(query, 'status')) {
    output.status = normalizeOptionalText(query.status);
  }

  if (hasOwn(query, 'sourceKind')) {
    output.sourceKind = normalizeOptionalText(query.sourceKind);
  }

  if (hasOwn(query, 'sourceRef')) {
    output.sourceRef = normalizeOptionalText(query.sourceRef);
  }

  if (hasOwn(query, 'subjectKind')) {
    output.subjectKind = normalizeOptionalText(query.subjectKind);
  }

  if (hasOwn(query, 'subjectRef')) {
    output.subjectRef = normalizeOptionalText(query.subjectRef);
  }

  if (hasOwn(query, 'workflowId')) {
    output.workflowId = normalizeOptionalText(query.workflowId);
  }

  if (hasOwn(query, 'taskId')) {
    output.taskId = normalizeOptionalText(query.taskId);
  }

  if (hasOwn(query, 'eventKinds')) {
    output.eventKinds = normalizeOptionalTextArray(query.eventKinds, 'eventKinds') || [];
  } else if (hasOwn(query, 'eventKind')) {
    output.eventKind = normalizeOptionalText(query.eventKind);
  }

  if (hasOwn(query, 'graph')) {
    output.graph = query.graph == null ? undefined : Boolean(query.graph);
  }

  if (hasOwn(query, 'linkRelations')) {
    output.linkRelations = normalizeOptionalTextArray(query.linkRelations, 'linkRelations') || [];
  } else if (hasOwn(query, 'linkRelation')) {
    output.linkRelation = normalizeOptionalText(query.linkRelation);
  }

  if (hasOwn(query, 'tags')) {
    output.tags = normalizeOptionalArray(query.tags, 'tags') || [];
  }

  if (hasOwn(query, 'minConfidence')) {
    output.minConfidence = query.minConfidence == null ? null : normalizeNumber(query.minConfidence, 'minConfidence');
  }

  if (hasOwn(query, 'semantic')) {
    output.semantic = normalizeRecallSemanticOverride(query.semantic);
  }

  if (hasOwn(query, 'limit')) {
    output.limit = normalizePositiveInteger(query.limit, 'limit');
  }

  return output;
}

function normalizeRecallSemanticOverride(value) {
  if (value == null) {
    return null;
  }

  if (value === false) {
    return false;
  }

  throw new Error('semantic recall override currently only supports false.');
}

function normalizeMemoryOptions(memory) {
  if (memory == null || memory === false) {
    return null;
  }

  if (memory === true) {
    return {};
  }

  if (isMemorySystem(memory)) {
    return {};
  }

  if (typeof memory !== 'object') {
    return null;
  }

  if (memory.enabled === false) {
    return null;
  }

  return memory;
}

function isMemorySystem(value) {
  return Boolean(value)
    && typeof value.remember === 'function'
    && typeof value.updateMemory === 'function'
    && typeof value.recall === 'function'
    && typeof value.getMemoryState === 'function'
    && typeof value.archiveMemory === 'function';
}

function normalizeOptionalStructureValue(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }

  if (typeof value === 'object') {
    return value;
  }

  throw new Error('structureJson must be an object or JSON string.');
}

function normalizeOptionalLinks(value) {
  if (value == null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('links must be an array.');
  }

  return value.map((link, index) => {
    if (!link || typeof link !== 'object') {
      throw new Error(`Link at index ${index} must be an object.`);
    }

    return {
      targetMemoryId: normalizeRequiredText(link.targetMemoryId, `Link targetMemoryId at index ${index}`),
      relation: normalizeRequiredText(link.relation, `Link relation at index ${index}`)
    };
  });
}

function normalizeOptionalArray(value, label) {
  if (value == null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value;
}

function normalizeOptionalTextArray(value, label) {
  const entries = normalizeOptionalArray(value, label);
  if (entries == null) {
    return undefined;
  }

  return entries.map((entry, index) => normalizeRequiredText(entry, `${label}[${index}]`));
}

function normalizeRequiredText(value, label) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }

  return text;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function normalizeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a number.`);
  }

  return number;
}

function normalizeOptionalPositiveInteger(value, options = {}) {
  if (value == null) {
    return null;
  }

  const number = Number(value);
  const allowZero = options.allowZero === true;
  if (!Number.isFinite(number)) {
    return null;
  }

  if (allowZero) {
    return number < 0 ? null : Math.floor(number);
  }

  return number <= 0 ? null : Math.floor(number);
}

function normalizePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return Math.floor(number);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
